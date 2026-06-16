import type { FollowedCompany } from './jobStore'

export function isLinkedInPagesUrl(url: string): boolean {
  return (
    url.includes('/mynetwork/pages') ||
    url.includes('/mynetwork/network-manager/company') ||
    url.includes('/mynetwork/network-manager/companies') ||
    url.includes('/mynetwork/following') ||
    url.includes('/mynetwork/grow')
  )
}

export function isFollowedCompaniesApiUrl(url: string): boolean {
  return (
    (url.includes('following') && url.includes('COMPANY')) ||
    url.includes('followingCompanies') ||
    (url.includes('/mynetwork/') && url.includes('entityType=COMPANY')) ||
    (url.includes('following-api') && url.includes('COMPANY'))
  )
}

// Parse LinkedIn's followed companies API response
// Handles multiple known response shapes defensively
export function parseFollowedCompaniesResponse(
  rawJson: unknown
): FollowedCompany[] {
  const results: FollowedCompany[] = []
  const seen = new Set<string>()

  if (!rawJson || typeof rawJson !== 'object') return results

  const json = rawJson as Record<string, unknown>

  // Helper: extract company data from a single element
  function extractFromElement(el: unknown): FollowedCompany | null {
    if (!el || typeof el !== 'object') return null
    const obj = el as Record<string, unknown>

    // Try to find company miniProfile or entityResult
    const miniProfile =
      (obj.company as Record<string, unknown>)?.miniProfile ??
      (obj.entityResult as Record<string, unknown>)?.entityResult ??
      (obj.followedEntity as Record<string, unknown>) ??
      obj

    const profileObj = miniProfile as Record<string, unknown>

    // Extract slug from publicIdentifier or trackingUrn
    let slug = ''
    if (typeof profileObj.publicIdentifier === 'string') {
      slug = profileObj.publicIdentifier
    } else if (typeof profileObj.universalName === 'string') {
      slug = profileObj.universalName
    } else if (typeof profileObj.entityUrn === 'string') {
      // urn:li:company:12345 — numeric, skip
      const urnMatch = profileObj.entityUrn.match(/urn:li:company:(\d+)/)
      if (urnMatch) return null // numeric IDs useless for URL construction
    }

    // Validate slug
    if (!slug || /^\d+$/.test(slug) || slug.length < 2) return null

    slug = slug.toLowerCase().trim()
    if (seen.has(slug)) return null

    // Extract numeric companyId
    let companyId = ''
    if (typeof profileObj.entityUrn === 'string') {
      const idMatch = profileObj.entityUrn.match(/\d+$/)
      if (idMatch) companyId = idMatch[0]
    }

    // Extract name
    let name = ''
    const nameObj =
      (profileObj.name as Record<string, unknown>) ?? null
    if (typeof profileObj.localizedName === 'string') {
      name = profileObj.localizedName
    } else if (nameObj && typeof nameObj.text === 'string') {
      name = nameObj.text
    } else if (typeof profileObj.name === 'string') {
      name = profileObj.name
    }
    if (!name) name = humanizeSlug(slug)

    // Extract logo
    let logoUrl = ''
    try {
      const logoData =
        (profileObj.logo as Record<string, unknown>) ??
        (profileObj.logoV2 as Record<string, unknown>)
      if (logoData) {
        const artifacts =
          ((logoData.image as Record<string, unknown>)
            ?.attributes as unknown[]) ?? []
        for (const attr of artifacts) {
          const a = attr as Record<string, unknown>
          const vectorImage =
            (a.detailDataUnion as Record<string, unknown>)
              ?.vectorImage as Record<string, unknown>
          if (vectorImage) {
            const rootUrl = vectorImage.rootUrl as string
            const artList =
              (vectorImage.artifacts as unknown[]) ?? []
            const best = artList[artList.length - 1] as
              | Record<string, unknown>
              | undefined
            if (rootUrl && best) {
              logoUrl = rootUrl + (best.fileIdentifyingUrlPathSegment as string)
              break
            }
          }
        }
      }
    } catch { /* logo is optional */ }

    seen.add(slug)
    return { slug, name, logoUrl, companyId }
  }

  // Strategy A: paging.elements[] or elements[]
  const elements =
    (json.elements as unknown[]) ??
    ((json.data as Record<string, unknown>)?.elements as unknown[]) ??
    []

  for (const el of elements) {
    const company = extractFromElement(el)
    if (company) results.push(company)
  }

  // Strategy B: included[] — graph-style response
  const included = (json.included as unknown[]) ?? []
  for (const item of included) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const type = (obj.$type as string) ?? ''
    if (
      type.includes('Company') ||
      type.includes('Organization') ||
      typeof obj.publicIdentifier === 'string'
    ) {
      const company = extractFromElement(item)
      if (company) results.push(company)
    }
  }

  console.log(
    '[NextRole:Slugs] Parsed',
    results.length,
    'companies from API:',
    results.map(c => c.slug).join(', ')
  )
  return results
}

// DOM fallback — only called if API intercept yields nothing after 10s
export function extractFollowedCompaniesDom(
  document: Document
): FollowedCompany[] {
  const results: FollowedCompany[] = []
  const seen = new Set<string>()

  const skipSlugs = new Set([
    'add', 'create', 'setup', 'universal-search', 'unknown', 'show',
    'view', 'following', 'follow', 'unfollow', 'company', 'companies',
    'pages', 'network', 'mynetwork', 'search', 'jobs', 'in', 'pub',
    'posts', 'about', 'people', 'life', 'insights', 'products',
    'videos', 'grow',
  ])

  const anchors = Array.from(
    document.querySelectorAll('a[href*="/company/"]')
  ) as HTMLAnchorElement[]

  for (const anchor of anchors) {
    const href = anchor.href || anchor.getAttribute('href') || ''
    // MUST start with letter — rejects numeric IDs
    const match = href.match(/\/company\/([a-zA-Z][a-zA-Z0-9\-_.]*)\/?/)
    if (!match) continue

    const slug = match[1].toLowerCase()
    if (!slug || skipSlugs.has(slug) || seen.has(slug)) continue
    if (/^\d+$/.test(slug)) continue

    // Find name
    let name = ''
    const container = anchor.closest(
      'li, article, [data-view-name], div[class*="entity"], div[class*="result"]'
    )
    if (container) {
      const heading = container.querySelector(
        'h1,h2,h3,h4,span[class*="name"],span[class*="title"],.org-list-item__name'
      )
      name = heading?.textContent?.trim() ?? ''
    }
    if (!name) {
      const t = anchor.textContent?.trim() ?? ''
      if (t.length > 2 && t.length < 80 && !t.includes('http')) name = t
    }
    if (!name) name = humanizeSlug(slug)

    // Find logo
    let logoUrl = ''
    if (container) {
      const img = container.querySelector(
        'img[src*="media.licdn"],img[src*="company"],img'
      ) as HTMLImageElement | null
      if (img) logoUrl = img.src
    }

    seen.add(slug)
    results.push({ slug, name, logoUrl })
  }

  console.log(
    '[NextRole:Slugs] DOM fallback found',
    results.length,
    'companies'
  )
  return results
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
