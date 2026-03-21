FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/render/project/src

COPY package*.json ./
RUN npm install

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=3000
ENV PATH="/opt/venv/bin:$PATH"
EXPOSE 3000

CMD ["node", "server.js"]
