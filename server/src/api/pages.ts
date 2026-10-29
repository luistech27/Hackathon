import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'

const PUBLIC_DIR = new URL('../../public/', import.meta.url)

const STYLES = ['styles.css', 'greenhouses.css']
const SCRIPTS = ['app.js', 'ui.js', 'orders.js', 'greenhouses.js', 'agent.js']
const PAGES = [
  { url: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  ...STYLES.map((file) => ({ url: `/${file}`, file, type: 'text/css; charset=utf-8' })),
  ...SCRIPTS.map((file) => ({ url: `/${file}`, file, type: 'text/javascript; charset=utf-8' }))
]

// The dashboard: a few fixed files read once at startup, so no request can name any other file.
// They are public; everything they show comes from the API, which checks the session.
export async function pageRoutes(app: FastifyInstance): Promise<void> {
  for (const page of PAGES) {
    const body = await readFile(new URL(page.file, PUBLIC_DIR))
    app.get(page.url, { config: { public: true } }, async (_request, reply) =>
      reply.type(page.type).header('cache-control', 'no-cache').send(body)
    )
  }
}
