# UM-154: image of the MCP server `@x207/mcp` (stdio), built from this repository; used for the Glama listing and for anyone who prefers a container.
# Read tools only: no key is set, X207_MCP_WRITE is not set. The defaults point at the public testnet circle and its read API.
#   docker build -t x207-mcp .
#   docker run -i --rm x207-mcp
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
# install only the three packages the server needs, then compile them (core, scheme, mcp)
RUN npm ci --ignore-scripts --workspace=@x207/core --workspace=@x207/scheme --workspace=@x207/mcp --include-workspace-root \
 && npx tsc -b packages/mcp \
 && npm prune --omit=dev --workspace=@x207/core --workspace=@x207/scheme --workspace=@x207/mcp

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    X207_CIRCLE_CONTRACT=x207-v013.testnet \
    X207_CIRCLE_ID=agents-main \
    X207_BACKEND_URL=https://x207.boxd.sh
COPY --from=build /app /app
USER node
# stdio: stdout belongs to the protocol, log lines go to stderr
ENTRYPOINT ["node", "packages/mcp/dist/cli.js"]
