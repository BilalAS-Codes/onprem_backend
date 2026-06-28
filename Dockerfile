FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production

EXPOSE 4000

CMD ["npm", "start"]