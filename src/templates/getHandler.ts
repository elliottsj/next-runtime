/* eslint-disable @typescript-eslint/no-var-requires */
import type { NextConfig } from '../helpers/config'

const { promises } = require('fs')
const { Server } = require('http')
const path = require('path')
// eslint-disable-next-line node/prefer-global/url, node/prefer-global/url-search-params
const { URLSearchParams, URL } = require('url')

const { Bridge } = require('@vercel/node/dist/bridge')

const { augmentFsModule, getMaxAge, getMultiValueHeaders, getNextServer } = require('./handlerUtils')

const makeHandler =
  () =>
  // We return a function and then call `toString()` on it to serialise it as the launcher function
  // eslint-disable-next-line max-params
  (conf: NextConfig, app, pageRoot, staticManifest: Array<[string, string]> = [], mode = 'ssr') => {
    // This is just so nft knows about the page entrypoints. It's not actually used
    try {
      // eslint-disable-next-line node/no-missing-require
      require.resolve('./pages.js')
    } catch {}
    // eslint-disable-next-line no-underscore-dangle
    process.env._BYPASS_SSG = 'true'

    const ONE_YEAR_IN_SECONDS = 31536000

    // We don't want to write ISR files to disk in the lambda environment
    conf.experimental.isrFlushToDisk = false

    // Set during the request as it needs the host header. Hoisted so we can define the function once
    let base

    augmentFsModule({ promises, staticManifest, pageRoot, getBase: () => base })

    const NextServer = getNextServer()

    const nextServer = new NextServer({
      conf,
      dir: path.resolve(__dirname, app),
      customServer: false,
    })
    const requestHandler = nextServer.getRequestHandler()
    const server = new Server(async (req, res) => {
      try {
        await requestHandler(req, res)
      } catch (error) {
        console.error(error)
        throw new Error('server function error')
      }
    })
    const bridge = new Bridge(server)
    bridge.listen()

    return async (event, context) => {
      let requestMode = mode
      // Ensure that paths are encoded - but don't double-encode them
      event.path = new URL(event.path, event.rawUrl).pathname
      // Next expects to be able to parse the query from the URL
      const query = new URLSearchParams(event.queryStringParameters).toString()
      event.path = query ? `${event.path}?${query}` : event.path
      // Only needed if we're intercepting static files
      if (staticManifest.length !== 0) {
        const { host } = event.headers
        const protocol = event.headers['x-forwarded-proto'] || 'http'
        base = `${protocol}://${host}`
      }
      const { headers, ...result } = await bridge.launcher(event, context)

      // Convert all headers to multiValueHeaders

      const multiValueHeaders = getMultiValueHeaders(headers)

      if (multiValueHeaders['set-cookie']?.[0]?.includes('__prerender_bypass')) {
        delete multiValueHeaders.etag
        multiValueHeaders['cache-control'] = ['no-cache']
      }

      // Sending SWR headers causes undefined behaviour with the Netlify CDN
      const cacheHeader = multiValueHeaders['cache-control']?.[0]

      if (cacheHeader?.includes('stale-while-revalidate')) {
        if (requestMode === 'odb' && process.env.EXPERIMENTAL_ODB_TTL) {
          requestMode = 'isr'
          const ttl = getMaxAge(cacheHeader)
          // Long-expiry TTL is basically no TTL
          if (ttl > 0 && ttl < ONE_YEAR_IN_SECONDS) {
            result.ttl = ttl
          }
          multiValueHeaders['x-rendered-at'] = [new Date().toISOString()]
        }
        multiValueHeaders['cache-control'] = ['public, max-age=0, must-revalidate']
      }
      multiValueHeaders['x-render-mode'] = [requestMode]
      return {
        ...result,
        multiValueHeaders,
        isBase64Encoded: result.encoding === 'base64',
      }
    }
  }

export const getHandler = ({ isODB = false, publishDir = '../../../.next', appDir = '../../..' }): string => `
const { Server } = require("http");
const { promises } = require("fs");
// We copy the file here rather than requiring from the node module
const { Bridge } = require("./bridge");
const { augmentFsModule, getMaxAge, getMultiValueHeaders, getNextServer } = require('./handlerUtils')

const { builder } = require("@netlify/functions");
const { config }  = require("${publishDir}/required-server-files.json")
let staticManifest 
try {
  staticManifest = require("${publishDir}/static-manifest.json")
} catch {}
const path = require("path");
const pageRoot = path.resolve(path.join(__dirname, "${publishDir}", config.target === "server" ? "server" : "serverless", "pages"));
exports.handler = ${
  isODB
    ? `builder((${makeHandler().toString()})(config, "${appDir}", pageRoot, staticManifest, 'odb'));`
    : `(${makeHandler().toString()})(config, "${appDir}", pageRoot, staticManifest, 'ssr');`
}
`
/* eslint-enable @typescript-eslint/no-var-requires */