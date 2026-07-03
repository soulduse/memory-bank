const ALLOWED_ENDPOINTS = new Set(['login', 'profile', 'chat']);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function serviceStopped() {
  return json({
    error: 'service_stopped',
    message: '서비스 중지상태입니다. 로컬 터미널 연결이 닫혀 있어요.',
  }, 503);
}

function localOrigin() {
  const raw = process.env.HUE_OS_LOCAL_ORIGIN;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function forwardedIp(request) {
  return request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-vercel-forwarded-for')
    || '';
}

function proxyHeaders(request) {
  const headers = new Headers();
  const blocked = new Set(['host', 'connection', 'content-length', 'accept-encoding']);
  for (const [key, value] of request.headers.entries()) {
    if (blocked.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  const ip = forwardedIp(request);
  if (ip) headers.set('x-forwarded-for', ip);
  headers.set('x-hue-os-vercel-bridge', '1');
  return headers;
}

function setResponseHeaders(target, upstreamHeaders) {
  const passthrough = ['content-type', 'cache-control'];
  for (const key of passthrough) {
    const value = upstreamHeaders.get(key);
    if (value) target.set(key, value);
  }
  target.set('cache-control', upstreamHeaders.get('cache-control') || 'no-store');

  const getSetCookie = upstreamHeaders.getSetCookie;
  if (typeof getSetCookie === 'function') {
    for (const cookie of getSetCookie.call(upstreamHeaders)) {
      target.append('set-cookie', cookie);
    }
  } else {
    const cookie = upstreamHeaders.get('set-cookie');
    if (cookie) target.set('set-cookie', cookie);
  }
}

export async function proxyHueOs(request, endpoint) {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return json({ error: 'not_found' }, 404);
  }

  const origin = localOrigin();
  if (!origin) {
    return serviceStopped();
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`/api/replacement-os/${endpoint}${sourceUrl.search}`, origin);
  const method = request.method.toUpperCase();
  const init = {
    method,
    headers: proxyHeaders(request),
    redirect: 'manual',
    signal: request.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(targetUrl, init);
    if (upstream.status >= 500) {
      return serviceStopped();
    }
    const headers = new Headers();
    setResponseHeaders(headers, upstream.headers);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return serviceStopped();
  }
}
