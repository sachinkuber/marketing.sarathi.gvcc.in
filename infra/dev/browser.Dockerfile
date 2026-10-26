# The Node image of infra/dev/server-run.sh (node:24.20.0, pinned by digest) plus Chromium for the browser
# checks (apps/dashboard/e2e). Built once on the development server:
#   docker build -f infra/dev/browser.Dockerfile -t mkt-dev-browser:1 infra/dev
# The Playwright version is the one in apps/dashboard/package.json; change both together, and the tag.
FROM node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.63.0 install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm
