// One POST per page view, and nothing else: the same count jugalm.com keeps, to the same self-hosted Umami
// (stats.jugalm.com) under the same website id, so the whole domain reads as one site and this game is the rows
// whose URL begins /flight/. No cookies, no storage, no identifier; Do Not Track and Global Privacy Control are
// honoured; a local build or an automated run is not a visit. sendBeacon returns at once and the browser sends on
// its own schedule, so this cannot cost a frame. text/plain is load-bearing: sendBeacon always sends credentials,
// application/json would force a preflight, and a credentialed preflight refuses Umami's wildcard allow-origin.
const n = navigator;
const mine = () => {   // the author's off switch: ?nocount on any page of jugalm.com, ?count to undo; one key, the whole domain, never sent
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('nocount')) localStorage.setItem('nocount', '1'); else if (q.has('count')) localStorage.removeItem('nocount');
    return localStorage.getItem('nocount') === '1';
  } catch { return false; }
};
if (location.hostname === 'jugalm.com' && !n.webdriver && n.sendBeacon
    && n.doNotTrack !== '1' && window.doNotTrack !== '1' && n.globalPrivacyControl !== true && !mine()) {
  try {
    n.sendBeacon('https://stats.jugalm.com/api/send', new Blob([JSON.stringify({ type: 'event', payload: {
      website: '0a907e1e-2783-4515-b2bf-d5a2b7d8db57', hostname: location.hostname, url: location.pathname,
      title: document.title, referrer: document.referrer, screen: `${screen.width}x${screen.height}`, language: n.language,
    } })], { type: 'text/plain;charset=UTF-8' }));
  } catch { /* counting is never worth an error in the console */ }
}
