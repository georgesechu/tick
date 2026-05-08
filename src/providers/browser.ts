import { writeFileSync } from 'node:fs'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import type { Browser } from '../core/interfaces.js'
import type { BrowseAction, BrowseResult } from '../core/types.js'

const MAX_CONTENT = 8000 // chars — fits comfortably in context

export class ReadableBrowser implements Browser {
  private turndown: TurndownService

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    })
    // Strip script, style, nav, footer, header, aside
    this.turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript'])
  }

  async browse(action: BrowseAction): Promise<BrowseResult> {
    const mode = action.mode ?? 'readable'

    try {
      switch (mode) {
        case 'readable': return await this.browseReadable(action.url)
        case 'raw': return await this.browseRaw(action.url)
        case 'screenshot': return await this.browseScreenshot(action.url, action.saveTo ?? '/tmp/screenshot.png')
      }
    } catch (err) {
      return {
        url: action.url,
        title: '',
        content: '',
        mode,
        success: false,
        error: (err as Error).message,
      }
    }
  }

  private async browseReadable(url: string): Promise<BrowseResult> {
    const html = await this.fetchHTML(url)
    const { document } = parseHTML(html)

    // Try Readability first (works great for articles)
    const reader = new Readability(document as any)
    const article = reader.parse()

    let markdown: string
    let title: string

    if (article?.content) {
      title = article.title ?? document.title ?? url
      markdown = this.turndown.turndown(article.content)
    } else {
      // Readability failed — fall back to body content
      title = document.title ?? url
      const body = document.querySelector('body')
      markdown = body ? this.turndown.turndown(body.innerHTML) : 'Could not extract content'
    }

    // Truncate if too long
    if (markdown.length > MAX_CONTENT) {
      markdown = markdown.slice(0, MAX_CONTENT) + '\n\n... [truncated]'
    }

    // Clean up excessive whitespace
    markdown = markdown
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return {
      url,
      title,
      content: markdown,
      mode: 'readable',
      success: true,
      error: null,
    }
  }

  private async browseRaw(url: string): Promise<BrowseResult> {
    const html = await this.fetchHTML(url)
    const { document } = parseHTML(html)

    // Return visible text content, not raw HTML
    const body = document.querySelector('body')
    let text = body?.textContent ?? ''

    // Clean up
    text = text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim()

    if (text.length > MAX_CONTENT) {
      text = text.slice(0, MAX_CONTENT) + '\n... [truncated]'
    }

    return {
      url,
      title: document.title ?? url,
      content: text,
      mode: 'raw',
      success: true,
      error: null,
    }
  }

  private async browseScreenshot(url: string, saveTo: string): Promise<BrowseResult> {
    // Screenshot requires Playwright — check if available, install if not
    try {
      // @ts-ignore — playwright is optional, only needed for screenshots
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      await page.screenshot({ path: saveTo, fullPage: false })
      const title = await page.title()
      await browser.close()

      return {
        url,
        title,
        content: saveTo,
        mode: 'screenshot',
        success: true,
        error: null,
      }
    } catch (err) {
      return {
        url,
        title: '',
        content: '',
        mode: 'screenshot',
        success: false,
        error: `Screenshot failed: ${(err as Error).message}. Install Playwright with: npx playwright install chromium`,
      }
    }
  }

  private async fetchHTML(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TickBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.text()
  }
}
