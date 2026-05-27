FROM node:22-alpine
LABEL "language"="nodejs"
LABEL "framework"="express"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
