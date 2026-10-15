# Hosting your own copy

albedo is a static site. Build it and serve the `dist/` folder from any web server, at a domain root or under a path:

```sh
git clone https://github.com/ZahakJ/albedo.git && cd albedo
npm install
npm run setup-models   # the AI models, checked by SHA-256
npm run build
npx serve dist         # or any static server
```

The server needs no special headers. It should serve `.wasm` as `application/wasm` and answer requests in parallel.

Without `setup-models` everything but the AI tools works. The models and their licenses are listed in [MODELS.md](https://github.com/ZahakJ/albedo/blob/main/docs/MODELS.md).
