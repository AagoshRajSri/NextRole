const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function testLinkedIn() {
  const guestUrl = `https://www.linkedin.com/jobs/google-jobs`
  const res = await fetch(guestUrl, { headers: { 'User-Agent': UA } })
  const html = await res.text()
  
  const jobs = []
  
  // Method using simple substrings
  let currentIndex = 0
  while (true) {
    const cardStart = html.indexOf('base-search-card', currentIndex)
    if (cardStart === -1) break
    const cardEnd = html.indexOf('base-search-card', cardStart + 1)
    const cardHtml = cardEnd === -1 ? html.substring(cardStart) : html.substring(cardStart, cardEnd)
    
    const idMatch = cardHtml.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/)
    const titleMatch = cardHtml.match(/<h3 class="base-search-card__title">\s*(.+?)\s*<\/h3>/) || cardHtml.match(/<span class="sr-only">\s*(.+?)\s*<\/span>/)
    const compMatch = cardHtml.match(/<h4 class="base-search-card__subtitle">\s*<a[^>]*>\s*(.+?)\s*<\/a>/) || cardHtml.match(/<h4 class="base-search-card__subtitle">\s*(.+?)\s*<\/h4>/)
    const locMatch = cardHtml.match(/<span class="job-search-card__location">\s*(.+?)\s*<\/span>/)
    const hrefMatch = cardHtml.match(/href="([^"?]+)[^"]*"/)
    
    if (titleMatch && idMatch) {
      jobs.push({
        atsJobId: idMatch[1],
        title: titleMatch[1].trim(),
        companyName: compMatch ? compMatch[1].trim() : '',
        location: locMatch ? locMatch[1].trim() : '',
        url: hrefMatch ? hrefMatch[1] : `https://www.linkedin.com/jobs/view/${idMatch[1]}`,
      })
    }
    
    currentIndex = cardStart + 1
  }
  console.log("Jobs found:", jobs.length)
  console.log(jobs[0])
}

testLinkedIn().catch(console.error)
