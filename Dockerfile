FROM python:3.12-slim

# Install Node.js 20 LTS + build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y curl build-essential python3 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# Install Node dependencies (root)
COPY package*.json ./
RUN npm install

# Install bridge dependencies (includes better-sqlite3 native build)
COPY server/bridge/package*.json server/bridge/
RUN cd server/bridge && npm install

# Install dashboard dependencies
COPY dashboard/package*.json dashboard/
RUN cd dashboard && npm install

# Copy all source
COPY . .

# Build dashboard → server/bridge/public/
RUN npm run build

EXPOSE 3001 8000

CMD ["npm", "run", "start"]
