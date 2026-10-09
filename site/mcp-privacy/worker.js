import policy from './index.html';
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'ombhrum.com' || !['/mcp-privacy', '/mcp-privacy/'].includes(url.pathname)) return new Response('Not found', {status:404});
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
  return new Response(request.method === 'HEAD' ? null : policy, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
}};
