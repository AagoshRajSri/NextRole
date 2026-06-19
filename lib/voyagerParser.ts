import type { JobCard } from './jobStore';

export function parseVoyagerResponse(
  rawJson: unknown,
  companySlug: string,
  companyName: string,
  companyLogoUrl: string
): Array<Omit<JobCard, 'matchScore' | 'status' | 'detectedAt'>> {
  try {
    const results: Array<Omit<JobCard, 'matchScore' | 'status' | 'detectedAt'>> = [];
    const seenIds = new Set<string>();

    const safePush = (id: string, title: string, location: string, listedAt: number, customLogo?: string) => {
      if (!id || !title || seenIds.has(id)) return;
      seenIds.add(id);

      const diff = Date.now() - listedAt;
      let postedAt = '';
      if (diff < 60000) postedAt = 'Just now';
      else if (diff < 3600000) postedAt = `${Math.floor(diff/60000)}m ago`;
      else if (diff < 86400000) postedAt = `${Math.floor(diff/3600000)}h ago`;
      else if (diff < 604800000) postedAt = `${Math.floor(diff/86400000)}d ago`;
      else postedAt = `${Math.floor(diff/604800000)}w ago`;

      results.push({
        id,
        company: companyName,
        companySlug,
        companyLogoUrl: customLogo || companyLogoUrl,
        role: title,
        location: location,
        postedAt,
        applyUrl: `https://www.linkedin.com/jobs/view/${id}/`
      });
    };

    if (typeof rawJson !== 'object' || !rawJson) return [];

    const obj = rawJson as any;
    let counts = { A: 0, B: 0, C: 0, D: 0 };

    // Structure A & C
    if (Array.isArray(obj.elements)) {
      for (const el of obj.elements) {
        if (!el) continue;
        // Structure A
        if (el.jobCardUnion?.jobPostingCard) {
          const card = el.jobCardUnion.jobPostingCard;
          const id = card.jobPostingId?.toString();
          const title = card.title;
          const loc = card.secondaryDescription?.text || '';
          const listedAt = card.listedAt || Date.now();
          safePush(id, title, loc, listedAt);
          counts.A++;
        } 
        // Structure C
        else if (el.id && el.title) {
          safePush(el.id.toString(), el.title, el.formattedLocation || '', el.listedAt || Date.now());
          counts.C++;
        }
      }
    }

    // Structure B
    if (obj.data && Array.isArray(obj.data.elements)) {
      for (const el of obj.data.elements) {
        if (el.jobCardUnion?.jobPostingCard) {
          const card = el.jobCardUnion.jobPostingCard;
          const id = card.jobPostingId?.toString();
          const title = card.title;
          const loc = card.secondaryDescription?.text || '';
          const listedAt = card.listedAt || Date.now();
          safePush(id, title, loc, listedAt);
          counts.B++;
        }
      }
    }

    // Structure D
    if (Array.isArray(obj.included)) {
      for (const inc of obj.included) {
        if (inc.$type?.includes('JobPosting') && inc.entityUrn && inc.title) {
          const match = inc.entityUrn.match(/urn:li:jobPosting:(\d+)/);
          const id = match ? match[1] : null;
          if (id) {
            safePush(id, inc.title, inc.formattedLocation || '', inc.listedAt || Date.now());
            counts.D++;
          }
        }
      }
    }

    // [FIX-6] Structure E (jobs-guest)
    try {
      if (typeof rawJson === 'string' && (rawJson as string).includes('job-result-card')) {
        console.log('[NextRole:Parser] jobs-guest HTML response detected — skipping');
        return results;
      }

      const jg = rawJson as Record<string, unknown>;
      if (Array.isArray(jg.jobs)) {
        for (const job of jg.jobs as unknown[]) {
          const j = job as Record<string, unknown>;
          if (!j.id || !j.title) continue;
          safePush(String(j.id), String(j.title), String(j.location ?? 'Location not specified'), Number(j.listedAt ?? Date.now()));
        }
      }
    } catch { /* expected */ }

    console.log(`[NextRole:Parser] Parsed jobs - A:${counts.A} B:${counts.B} C:${counts.C} D:${counts.D}`);
    return results;
  } catch (err) {
    console.error('[NextRole:Parser] Error parsing voyager response:', err);
    return [];
  }
}
