/** The casino UI is plain static files in /public; serve index.html at "/". The API lives in app/api. */
module.exports = {
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/index.html' }] };
  },
};
