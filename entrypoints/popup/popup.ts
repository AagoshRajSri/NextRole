interface SavedSearch {
  id: string;
  companyName: string;
  url: string;
  createdAt: number;
}

document.addEventListener('DOMContentLoaded', async () => {
  const searchListContainer = document.getElementById('search-list');
  const savedCountElement = document.getElementById('saved-count');

  if (!searchListContainer || !savedCountElement) return;

  // Initialize and load saved searches
  await renderSavedSearches(searchListContainer, savedCountElement);

  // Initialize User ID in storage if background script hasn't run yet
  const userStorage = (await browser.storage.local.get('userId')) as any;
  if (!userStorage || !userStorage.userId) {
    const newId = `usr-${Math.random().toString(36).substring(2, 11)}`;
    await browser.storage.local.set({ userId: newId });
  }

  // ----------------------------------------------------
  // NAVIGATION TABS LOGIC
  // ----------------------------------------------------
  const tabTracked = document.getElementById('tab-tracked');
  const tabProfile = document.getElementById('tab-profile');
  const trackedView = document.getElementById('tracked-view');
  const profileView = document.getElementById('profile-view');

  if (tabTracked && tabProfile && trackedView && profileView) {
    tabTracked.addEventListener('click', () => {
      tabTracked.classList.add('active');
      tabProfile.classList.remove('active');
      trackedView.classList.remove('hidden');
      profileView.classList.add('hidden');
    });

    tabProfile.addEventListener('click', async () => {
      tabProfile.classList.add('active');
      tabTracked.classList.remove('active');
      profileView.classList.remove('hidden');
      trackedView.classList.add('hidden');
      
      // Load user profile and subscription status on profile view activation
      await loadProfileAndSubscription();
    });
  }

  // ----------------------------------------------------
  // PROFILE (MASTER RESUME) SUBMIT LOGIC
  // ----------------------------------------------------
  const profileForm = document.getElementById('profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const storage = (await browser.storage.local.get('userId')) as any;
      const userId = (storage?.userId as string) || 'default-user';
      
      const skills = (document.getElementById('prof-skills') as HTMLInputElement)?.value || '';
      const experience = (document.getElementById('prof-experience') as HTMLTextAreaElement)?.value || '';
      const education = (document.getElementById('prof-education') as HTMLTextAreaElement)?.value || '';
      const projects = (document.getElementById('prof-projects') as HTMLTextAreaElement)?.value || '';
      
      const saveBtn = document.getElementById('btn-save-profile');
      if (saveBtn) {
        saveBtn.textContent = 'Saving Resume...';
        saveBtn.setAttribute('disabled', 'true');
      }

      try {
        const res = await fetch('http://localhost:5000/api/profile', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId
          },
          body: JSON.stringify({ skills, experience, education, projects })
        });
        
        if (res.ok) {
          if (saveBtn) {
            saveBtn.textContent = 'Saved Successfully! ✓';
            saveBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
            setTimeout(() => {
              saveBtn.textContent = 'Save Master Resume';
              saveBtn.style.background = '';
              saveBtn.removeAttribute('disabled');
            }, 2000);
          }
        } else {
          throw new Error('Failed to save profile on backend');
        }
      } catch (err) {
        console.error('[Popup] Save profile failed:', err);
        if (saveBtn) {
          saveBtn.textContent = 'Error Saving! ❌';
          saveBtn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
          setTimeout(() => {
            saveBtn.textContent = 'Save Master Resume';
            saveBtn.style.background = '';
            saveBtn.removeAttribute('disabled');
          }, 2000);
        }
      }
    });
  }

  // ----------------------------------------------------
  // STRIPE PAYWALL BILLING LOGIC
  // ----------------------------------------------------
  const upgradeBtn = document.getElementById('btn-upgrade');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', async () => {
      const storage = (await browser.storage.local.get('userId')) as any;
      const userId = (storage?.userId as string) || 'default-user';
      
      upgradeBtn.textContent = 'Connecting...';
      upgradeBtn.setAttribute('disabled', 'true');

      try {
        const res = await fetch('http://localhost:5000/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId
          }
        });
        
        if (res.ok) {
          const data = await res.json();
          if (data.url) {
            // Open payment check out portal
            browser.tabs.create({ url: data.url });
            
            // Check if mock checkout triggered instant premium activation locally
            if (data.url.includes('mock-success-premium-activated')) {
              setTimeout(async () => {
                await loadProfileAndSubscription();
                upgradeBtn.textContent = 'Upgrade ($15/mo)';
                upgradeBtn.removeAttribute('disabled');
              }, 1200);
            }
          }
        } else {
          throw new Error('Failed to create checkout');
        }
      } catch (err) {
        console.error('[Popup] Stripe checkout redirection failed:', err);
        upgradeBtn.textContent = 'Failed ❌';
        setTimeout(() => {
          upgradeBtn.textContent = 'Upgrade ($15/mo)';
          upgradeBtn.removeAttribute('disabled');
        }, 1500);
      }
    });
  }
});

/**
 * Load user's profile and premium billing status from backend PostgreSQL
 */
async function loadProfileAndSubscription() {
  const storage = (await browser.storage.local.get('userId')) as any;
  const userId = (storage?.userId as string) || 'default-user';
  
  // 1. Fetch Subscription details
  try {
    const subRes = await fetch('http://localhost:5000/api/subscription', {
      headers: { 'X-User-Id': userId }
    });
    if (subRes.ok) {
      const subData = await subRes.json();
      const banner = document.getElementById('premium-banner');
      const statusText = document.getElementById('premium-status');
      const upgradeBtn = document.getElementById('btn-upgrade');
      
      if (banner && statusText && upgradeBtn) {
        if (subData.isActive) {
          banner.classList.add('active');
          statusText.innerHTML = '✨ NEXTROLE PREMIUM ACTIVE';
          upgradeBtn.style.display = 'none';
        } else {
          banner.classList.remove('active');
          statusText.innerHTML = 'FREE ACCOUNT';
          upgradeBtn.style.display = 'block';
        }
      }
    }
  } catch (err) {
    console.warn('[Popup] Backend subscription fetch failed:', err);
  }

  // 2. Fetch Profile details
  try {
    const profRes = await fetch('http://localhost:5000/api/profile', {
      headers: { 'X-User-Id': userId }
    });
    if (profRes.ok) {
      const profData = await profRes.json();
      
      const skillsInput = document.getElementById('prof-skills') as HTMLInputElement;
      const expTextarea = document.getElementById('prof-experience') as HTMLTextAreaElement;
      const eduTextarea = document.getElementById('prof-education') as HTMLTextAreaElement;
      const projTextarea = document.getElementById('prof-projects') as HTMLTextAreaElement;
      
      if (skillsInput) skillsInput.value = profData.skills || '';
      if (expTextarea) expTextarea.value = profData.experience || '';
      if (eduTextarea) eduTextarea.value = profData.education || '';
      if (projTextarea) projTextarea.value = profData.projects || '';
    }
  } catch (err) {
    console.warn('[Popup] Backend profile load failed:', err);
  }
}

async function renderSavedSearches(
  container: HTMLElement,
  countElement: HTMLElement
) {
  try {
    const data = (await browser.storage.local.get('savedSearches')) as any;
    const savedSearches = (data?.savedSearches as SavedSearch[]) || [];

    // Update count element
    countElement.textContent = `${savedSearches.length} saved`;

    // Clear previous items
    container.innerHTML = '';

    if (savedSearches.length === 0) {
      container.appendChild(createEmptyStateElement());
      return;
    }

    // Sort searches by most recently created
    const sortedSearches = [...savedSearches].sort((a, b) => b.createdAt - a.createdAt);

    sortedSearches.forEach((search) => {
      const card = createSearchCard(search, async () => {
        // Trigger visual delete animation
        card.classList.add('card-exit');
        card.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9) translateY(-10px)';

        setTimeout(async () => {
          // Remove from local storage
          const currentData = (await browser.storage.local.get('savedSearches')) as any;
          const currentSearches = (currentData?.savedSearches as SavedSearch[]) || [];
          const updatedSearches = currentSearches.filter((s) => s.id !== search.id);
          await browser.storage.local.set({ savedSearches: updatedSearches });

          // Sync deletion to backend
          try {
            const userStorage = (await browser.storage.local.get('userId')) as any;
            const userId = (userStorage?.userId as string) || 'default-user';
            
            // Search matching URL on backend to delete
            const searchesRes = await fetch('http://localhost:5000/api/tracked-searches', {
              headers: { 'X-User-Id': userId }
            });
            if (searchesRes.ok) {
              const backendSearches: any[] = await searchesRes.json();
              const backendMatch = backendSearches.find(s => s.url === search.url);
              if (backendMatch) {
                await fetch(`http://localhost:5000/api/tracked-searches/${backendMatch.id}`, {
                  method: 'DELETE',
                  headers: { 'X-User-Id': userId }
                });
                console.log('[Popup] Successfully synced deletion to backend database.');
              }
            }
          } catch (backendErr) {
            console.warn('[Popup] Deletion sync to backend offline.', backendErr);
          }

          // Re-render
          renderSavedSearches(container, countElement);
        }, 300);
      });
      container.appendChild(card);
    });
  } catch (err) {
    console.error('[NextRole] Error loading searches in popup:', err);
    container.innerHTML = `<div style="color: #f87171; padding: 20px; text-align: center; font-size: 13px;">Error loading saved searches.</div>`;
  }
}

function createSearchCard(search: SavedSearch, onDelete: () => void): HTMLElement {
  const card = document.createElement('div');
  card.className = 'search-card';

  const initial = search.companyName ? search.companyName.charAt(0) : '?';

  card.innerHTML = `
    <div class="card-details">
      <div class="avatar">${initial}</div>
      <div class="info">
        <div class="company-name">${escapeHtml(search.companyName)}</div>
        <a class="search-url" title="${escapeHtml(search.url)}" data-url="${escapeHtml(search.url)}">
          ${escapeHtml(cleanUrlDisplay(search.url))}
        </a>
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-open" title="Open Job Board" data-action="open">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      </button>
      <button class="btn btn-delete" title="Delete Tracked Search" data-action="delete">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      </button>
    </div>
  `;

  // Event handler to open links
  const openSearch = () => {
    browser.tabs.create({ url: search.url });
  };

  const urlElement = card.querySelector('.search-url');
  if (urlElement) {
    urlElement.addEventListener('click', (e) => {
      e.preventDefault();
      openSearch();
    });
  }

  const openBtn = card.querySelector('[data-action="open"]');
  if (openBtn) {
    openBtn.addEventListener('click', openSearch);
  }

  // Delete event handler
  const deleteBtn = card.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', onDelete);
  }

  return card;
}

function createEmptyStateElement(): HTMLElement {
  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  emptyState.innerHTML = `
    <div class="radar-scanner">
      <div class="radar-ring"></div>
      <div class="radar-ring-inner"></div>
      <div class="radar-beam"></div>
    </div>
    <div class="empty-title">No careers channels tracked yet</div>
    <div class="empty-desc">Visit any Workday, Greenhouse, or Lever careers board and click "Track Careers Page" to connect your feed.</div>
  `;
  return emptyState;
}

function cleanUrlDisplay(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    let display = url.hostname;
    if (url.pathname && url.pathname !== '/') {
      display += url.pathname;
    }
    if (url.search) {
      display += url.search;
    }
    // Limit to 45 chars for clean presentation
    if (display.length > 45) {
      return display.substring(0, 42) + '...';
    }
    return display;
  } catch (e) {
    return urlStr;
  }
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
