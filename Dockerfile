FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install Arabic fonts so Arabic websites render cleanly
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-core fonts-noto-ui-core \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
ENV VIEWPORT_W=1024
ENV VIEWPORT_H=576

EXPOSE 8080
CMD ["node", "server.js"]
