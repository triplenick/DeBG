async function checkReadiness(url, signal) {
  const response = await fetch(`${url}/openapi.json`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`rembg readiness HTTP ${response.status}`);
  const schema = await response.json();
  if (schema.info?.title !== 'Rembg' || !schema.paths?.['/api/remove']?.post) {
    throw new Error('The service on the rembg port is not the expected API.');
  }
}

module.exports = { checkReadiness };
