// Cloudflare Worker "marketing-relay", custom domain marketing.sarathi.gvcc.in (zone gvcc.in).
// That name is two levels deep, too deep for Cloudflare's free certificate (*.gvcc.in); a Worker custom domain gets
// its own certificate at no cost. The Worker forwards every request unchanged (method, path, query string, headers,
// body) to the origin name marketing-sarathi.gvcc.in, which the free certificate covers, and marks it with
// X-Gvcc-Relay so the origin's proxy redirects any visit that did not come through here. Redirects are passed back
// to the browser as they are. The origin's proxy restores Host to marketing.sarathi.gvcc.in.
// Same pattern as staging's stg-marketing-relay. Deployed by hand: Cloudflare -> Workers & Pages.
const ORIGIN_HOST = 'marketing-sarathi.gvcc.in'

export default {
  async fetch(request) {
    const url = new URL(request.url)
    url.protocol = 'https:'
    url.hostname = ORIGIN_HOST
    url.port = ''
    const forward = new Request(url.toString(), request)
    forward.headers.set('X-Gvcc-Relay', 'marketing')
    return fetch(forward, { redirect: 'manual' })
  },
}
