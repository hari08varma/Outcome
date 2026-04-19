# ── BUILD STAGE ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install all dependencies (including devDependencies needed for TS compilation)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Compile TypeScript to JavaScript in the /dist folder
RUN npm run build


# ── PRODUCTION STAGE ─────────────────────────────────────────────
FROM node:20-alpine AS production

# Set working directory
WORKDIR /app

# Set node environment
ENV NODE_ENV=production
# DigitalOcean injects dynamic ports, default to 3000
ENV PORT=3000 

# Copy package configurations
COPY package*.json ./

# Install ONLY production dependencies to minimize container size
RUN npm ci --omit=dev

# Copy compiled output from the builder stage
COPY --from=builder /app/dist ./dist

# Expose the application port
EXPOSE 3000

# Start gracefully using pure node (avoiding tsx in production)
CMD ["npm", "run", "start"]
