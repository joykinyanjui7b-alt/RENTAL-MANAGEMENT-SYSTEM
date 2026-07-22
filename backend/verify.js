const base = 'http://localhost:3000';
function parseSetCookie(value) {
  if (!value) return '';
  return value.split(';')[0];
}
(async () => {
  let cookie = '';
  const loginRes = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tenant@example.com', password: 'Password123!' })
  });
  const loginBody = await loginRes.text();
  console.log('LOGIN', loginRes.status, loginBody);
  const setCookie = loginRes.headers.get('set-cookie');
  if (setCookie) cookie = parseSetCookie(setCookie);

  const tenancyRes = await fetch(base + '/api/tenancies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ rentalId: 'seed-loft-1', moveInDate: '2026-08-01', message: 'Hello from verification' })
  });
  const tenancyBody = await tenancyRes.text();
  console.log('TENANCY', tenancyRes.status, tenancyBody);

  const dashboardRes = await fetch(base + '/api/dashboard', {
    headers: { Cookie: cookie }
  });
  const dashboardBody = await dashboardRes.text();
  console.log('DASHBOARD', dashboardRes.status, dashboardBody);
})();
