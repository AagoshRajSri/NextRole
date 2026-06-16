export function normaliseRole(role: string): string {
  return role.toLowerCase().trim().replace(/\s+/g, ' ');
}

// [FIX-3] Normalisation map for aliases
const ROLE_ALIASES: Record<string, string[]> = {
  'sde': ['software engineer', 'software developer', 'swe', 'software development engineer'],
  'swe': ['software engineer', 'software developer', 'sde'],
  'fsd': ['full stack', 'fullstack', 'full-stack'],
  'fe': ['frontend', 'front-end', 'front end', 'ui engineer'],
  'be': ['backend', 'back-end', 'back end', 'server side'],
  'ml': ['machine learning', 'ml engineer', 'ai engineer'],
  'devops': ['platform engineer', 'infrastructure', 'sre', 'reliability'],
  'pm': ['product manager', 'product management'],
  'ds': ['data scientist', 'data science'],
  'da': ['data analyst', 'data analysis'],
}

// [FIX-3] Expand roles
function expandRoles(roles: string[]): string[] {
  const expanded = [...roles]
  for (const role of roles) {
    const key = role.toLowerCase().trim()
    const aliases = ROLE_ALIASES[key] ?? []
    expanded.push(...aliases)
  }
  return [...new Set(expanded)]
}

export function scoreJobAgainstProfile(
  jobTitle: string,
  jobLocation: string,
  preferredRoles: string[],
  preferredLocations: string[]
): number {
  // LOCATION CHECK (hard filter)
  if (preferredLocations && preferredLocations.length > 0) {
    const jobLoc = jobLocation.toLowerCase().trim();
    let locMatch = false;
    for (const prefLoc of preferredLocations) {
      const p = prefLoc.toLowerCase().trim();
      const city = p.split(',')[0].trim();
      
      const checkWord = (target: string, query: string) => {
        if (!query || query.length < 2) return false;
        try {
          return new RegExp(`\\b${query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(target);
        } catch { return target.includes(query); }
      };

      if (jobLoc.includes(p) || checkWord(jobLoc, p) || (city.length > 2 && checkWord(jobLoc, city))) {
        locMatch = true;
        break;
      }
    }
    if (!locMatch) return 0;
  }

  // ROLE SCORE (0-100)
  if (!preferredRoles || preferredRoles.length === 0) {
    return 50;
  }

  // [FIX-3] Expand user's preferred roles with aliases
  const expandedRoles = expandRoles(preferredRoles);

  const jobTokens = jobTitle.toLowerCase().trim().split(/[\s\-\_\/]+/).filter(Boolean);
  let maxScore = 0;

  for (const role of expandedRoles) {
    const roleTokens = role.toLowerCase().trim().split(/[\s\-\_\/]+/).filter(Boolean);
    if (roleTokens.length === 0) continue;

    let overlap1 = 0;
    for (const t of roleTokens) {
      if (jobTokens.includes(t)) overlap1++;
    }

    let overlap2 = 0;
    for (const t of jobTokens) {
      if (roleTokens.includes(t)) overlap2++;
    }

    const overlap = Math.max(overlap1, overlap2);
    // Score based primarily on how much of the user's role is matched
    let score = (overlap / roleTokens.length) * 100;
    
    // Apply a small penalty for extra words in the job title (e.g., 'Senior', 'Staff')
    // so exact matches still score slightly higher.
    const extraWords = Math.max(0, jobTokens.length - overlap);
    score -= extraWords * 2;

    if (score > maxScore) {
      maxScore = score;
    }
  }

  // MINIMUM THRESHOLD
  if (maxScore < 30) return 0;
  return Math.round(maxScore);
}
