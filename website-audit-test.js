async function runWebsiteAudit(userOptions = {}) {
  const options = {
    maxPages: 25,
    maxDepth: 2,
    customUrls: [],
    includeSubdomains: false,
    testExternalLinks: false,
    externalLinkSampleSize: 10,
    requestTimeout: 12000,
    checkHashes: true,
    respectNoIndex: false,
    verbose: true,
    ...userOptions,
  };

  const startTime = performance.now();
  const origin = location.origin;
  const rootHost = location.hostname;

  const visited = new Set();
  const queued = new Set();
  const crawlQueue = [];

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: location.href,
    options,
    pages: [],
    summary: {
      pagesVisited: 0,
      pagesQueued: 0,
      totalErrors: 0,
      totalWarnings: 0,
      totalNotices: 0,
      brokenLinks: 0,
      brokenHashAnchors: 0,
      imagesMissingAlt: 0,
      formsMissingLabels: 0,
      buttonsMissingNames: 0,
      duplicateIds: 0,
      pagesWithNoH1: 0,
      pagesWithMultiH1: 0,
      pagesWithTitleIssues: 0,
      pagesWithDescriptionIssues: 0,
      pagesWithCanonicalIssues: 0,
      pagesWithLangIssues: 0,
      pagesWithViewportIssues: 0,
      pagesWithStructuredDataIssues: 0,
    },
    environment: {
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      connection: navigator.connection
        ? {
            effectiveType: navigator.connection.effectiveType,
            downlink: navigator.connection.downlink,
            rtt: navigator.connection.rtt,
            saveData: navigator.connection.saveData,
          }
        : null,
    },
    performance: {},
    notes: [
      "This audit works best on same-origin pages.",
      "Some checks are heuristic and may produce false positives.",
      "Cross-origin external link validation is limited unless fetch is allowed.",
      "Client-side rendering may affect fetched HTML if content is injected after load.",
    ],
  };

  function log(...args) {
    if (options.verbose) console.log("[WebsiteAudit]", ...args);
  }

  function warn(...args) {
    console.warn("[WebsiteAudit]", ...args);
  }

  function normalizeUrl(url, base = location.href) {
    try {
      return new URL(url, base).href.split("#")[0];
    } catch {
      return null;
    }
  }

  function sameSite(url) {
    try {
      const u = new URL(url, location.href);
      if (options.includeSubdomains) {
        return u.hostname === rootHost || u.hostname.endsWith("." + rootHost);
      }
      return u.origin === origin;
    } catch {
      return false;
    }
  }

  function isHttpLike(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function isProbablyBinaryResource(url) {
    return /\.(pdf|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|webp|svg|mp4|mp3|avi|mov|webm)(\?|$)/i.test(
      url,
    );
  }

  function unique(arr) {
    return [...new Set(arr)];
  }

  function textOf(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function attr(el, name) {
    return el?.getAttribute?.(name)?.trim() || "";
  }

  function safeParseJson(str) {
    try {
      return { ok: true, value: JSON.parse(str) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function createIssue(type, category, message, selector = null, extra = null) {
    return { type, category, message, selector, extra };
  }

  function getSelector(el) {
    if (!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      el.classList && el.classList.length
        ? "." + [...el.classList].slice(0, 3).join(".")
        : "";
    return `${tag}${id}${cls}`;
  }

  function addIssue(page, issue) {
    page.issues.push(issue);
    if (issue.type === "error") report.summary.totalErrors++;
    else if (issue.type === "warning") report.summary.totalWarnings++;
    else report.summary.totalNotices++;
  }

  function addToQueue(url, depth) {
    const clean = normalizeUrl(url);
    if (!clean) return;
    if (!sameSite(clean)) return;
    if (visited.has(clean) || queued.has(clean)) return;
    if (crawlQueue.length >= options.maxPages) return;
    queued.add(clean);
    crawlQueue.push({ url: clean, depth });
  }

  async function fetchWithTimeout(url, timeout = options.requestTimeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function validateLink(url) {
    try {
      const res = await fetchWithTimeout(url);
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        statusText: e.message || "Fetch failed",
      };
    }
  }

  function collectCurrentPagePerf() {
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource") || [];
    report.performance.currentPage = {
      navigation: nav
        ? {
            type: nav.type,
            domComplete: Math.round(nav.domComplete),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            loadEventEnd: Math.round(nav.loadEventEnd),
            transferSize: nav.transferSize,
            encodedBodySize: nav.encodedBodySize,
            decodedBodySize: nav.decodedBodySize,
          }
        : null,
      resourceCount: resources.length,
      jsResources: resources.filter((r) => r.initiatorType === "script").length,
      cssResources: resources.filter((r) => r.initiatorType === "link").length,
      imgResources: resources.filter((r) => r.initiatorType === "img").length,
      fontResources: resources.filter((r) => r.initiatorType === "font").length,
      largeResources: resources
        .filter((r) => r.transferSize > 300000)
        .sort((a, b) => b.transferSize - a.transferSize)
        .slice(0, 10)
        .map((r) => ({
          name: r.name,
          initiatorType: r.initiatorType,
          transferSize: r.transferSize,
          duration: Math.round(r.duration),
        })),
    };
  }

  function parseHTML(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function analyzeDocument(doc, pageUrl, responseMeta = {}) {
    const page = {
      url: pageUrl,
      status: responseMeta.status ?? null,
      ok: responseMeta.ok ?? true,
      contentType: responseMeta.contentType || "",
      title: doc.title || "",
      issues: [],
      metrics: {},
      extracted: {},
    };

    const html = doc.documentElement;
    const body = doc.body;

    if (!html) {
      addIssue(page, createIssue("error", "document", "HTML element missing"));
      return page;
    }

    const lang = attr(html, "lang");
    if (!lang) {
      addIssue(page, createIssue("warning", "a11y/seo", "Missing html[lang]"));
      report.summary.pagesWithLangIssues++;
    }

    const viewport = doc.querySelector('meta[name="viewport"]');
    if (!viewport) {
      addIssue(
        page,
        createIssue("warning", "mobile/seo", "Missing viewport meta tag"),
      );
      report.summary.pagesWithViewportIssues++;
    }

    const title = (doc.title || "").trim();
    if (!title) {
      addIssue(page, createIssue("error", "seo", "Missing <title> tag"));
      report.summary.pagesWithTitleIssues++;
    } else {
      if (title.length < 20) {
        addIssue(
          page,
          createIssue(
            "notice",
            "seo",
            `Title may be too short (${title.length} chars)`,
          ),
        );
      }
      if (title.length > 65) {
        addIssue(
          page,
          createIssue(
            "warning",
            "seo",
            `Title may be too long (${title.length} chars)`,
          ),
        );
        report.summary.pagesWithTitleIssues++;
      }
    }

    const metaDesc = doc.querySelector('meta[name="description"]');
    const metaDescContent = metaDesc?.getAttribute("content")?.trim() || "";
    if (!metaDescContent) {
      addIssue(page, createIssue("warning", "seo", "Missing meta description"));
      report.summary.pagesWithDescriptionIssues++;
    } else {
      if (metaDescContent.length < 70) {
        addIssue(
          page,
          createIssue(
            "notice",
            "seo",
            `Meta description may be short (${metaDescContent.length} chars)`,
          ),
        );
      }
      if (metaDescContent.length > 170) {
        addIssue(
          page,
          createIssue(
            "warning",
            "seo",
            `Meta description may be too long (${metaDescContent.length} chars)`,
          ),
        );
        report.summary.pagesWithDescriptionIssues++;
      }
    }

    const canonical = doc.querySelector('link[rel="canonical"]');
    const canonicalHref = canonical?.href || "";
    if (!canonicalHref) {
      addIssue(page, createIssue("warning", "seo", "Missing canonical URL"));
      report.summary.pagesWithCanonicalIssues++;
    } else {
      try {
        const c = new URL(canonicalHref, pageUrl).href;
        const p = new URL(pageUrl).href;
        if (c !== p) {
          addIssue(
            page,
            createIssue(
              "notice",
              "seo",
              "Canonical differs from page URL",
              null,
              { canonical: c, page: p },
            ),
          );
        }
      } catch {
        addIssue(page, createIssue("warning", "seo", "Invalid canonical URL"));
        report.summary.pagesWithCanonicalIssues++;
      }
    }

    const robots =
      doc.querySelector('meta[name="robots"]')?.getAttribute("content") || "";
    if (/noindex/i.test(robots) && !options.respectNoIndex) {
      addIssue(page, createIssue("notice", "seo", "Page is marked noindex"));
    }

    const h1s = [...doc.querySelectorAll("h1")];
    if (h1s.length === 0) {
      addIssue(page, createIssue("warning", "seo/content", "No H1 found"));
      report.summary.pagesWithNoH1++;
    }
    if (h1s.length > 1) {
      addIssue(
        page,
        createIssue(
          "warning",
          "seo/content",
          `Multiple H1s found (${h1s.length})`,
        ),
      );
      report.summary.pagesWithMultiH1++;
    }

    const headings = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(
      (h) => ({
        level: Number(h.tagName[1]),
        text: textOf(h).slice(0, 120),
        selector: getSelector(h),
      }),
    );
    for (let i = 1; i < headings.length; i++) {
      if (headings[i].level - headings[i - 1].level > 1) {
        addIssue(
          page,
          createIssue(
            "notice",
            "content/structure",
            `Heading level skip from h${headings[i - 1].level} to h${headings[i].level}`,
            headings[i].selector,
          ),
        );
      }
    }

    const duplicateIds = [];
    const idMap = new Map();
    [...doc.querySelectorAll("[id]")].forEach((el) => {
      const id = el.id;
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push(getSelector(el));
    });
    idMap.forEach((selectors, id) => {
      if (selectors.length > 1) {
        duplicateIds.push({ id, selectors });
      }
    });
    if (duplicateIds.length) {
      duplicateIds.forEach((d) => {
        addIssue(
          page,
          createIssue(
            "error",
            "html",
            `Duplicate id="${d.id}"`,
            null,
            d.selectors,
          ),
        );
      });
      report.summary.duplicateIds += duplicateIds.length;
    }

    const images = [...doc.images];
    const imagesMissingAlt = [];
    const lazyIssues = [];
    images.forEach((img) => {
      const alt = img.getAttribute("alt");
      const src = img.currentSrc || img.src || "";
      if (alt === null || alt.trim() === "") {
        imagesMissingAlt.push({ src, selector: getSelector(img) });
      }
      if (
        !img.hasAttribute("loading") &&
        !img.closest("picture") &&
        !img.closest("noscript")
      ) {
        lazyIssues.push({ src, selector: getSelector(img) });
      }
      if (!src) {
        addIssue(
          page,
          createIssue(
            "warning",
            "images",
            "Image without src",
            getSelector(img),
          ),
        );
      }
      if (img.width === 0 || img.height === 0) {
        addIssue(
          page,
          createIssue(
            "notice",
            "images",
            "Image may have zero rendered dimensions",
            getSelector(img),
            { src },
          ),
        );
      }
    });
    if (imagesMissingAlt.length) {
      imagesMissingAlt.forEach((item) => {
        addIssue(
          page,
          createIssue(
            "warning",
            "a11y/images",
            "Image missing alt text",
            item.selector,
            { src: item.src },
          ),
        );
      });
      report.summary.imagesMissingAlt += imagesMissingAlt.length;
    }
    if (lazyIssues.length > 5) {
      addIssue(
        page,
        createIssue(
          "notice",
          "performance/images",
          `${lazyIssues.length} images missing loading="lazy"`,
        ),
      );
    }

    const anchors = [...doc.querySelectorAll("a[href]")];
    const internalLinks = [];
    const externalLinks = [];
    const anchorIssues = [];
    const hashIssues = [];

    anchors.forEach((a) => {
      const hrefRaw = a.getAttribute("href") || "";
      const href = hrefRaw.trim();
      const selector = getSelector(a);
      const name = textOf(a) || attr(a, "aria-label") || attr(a, "title");

      if (!name && !a.querySelector("img,svg")) {
        anchorIssues.push(
          createIssue(
            "warning",
            "a11y/links",
            "Link has no accessible name",
            selector,
            { href },
          ),
        );
      }

      if (href === "#" || /^javascript:/i.test(href)) {
        anchorIssues.push(
          createIssue(
            "warning",
            "links",
            `Suspicious link href="${href}"`,
            selector,
          ),
        );
        return;
      }

      if (/^mailto:|^tel:/i.test(href)) return;

      let abs;
      try {
        abs = new URL(href, pageUrl);
      } catch {
        anchorIssues.push(
          createIssue("warning", "links", "Invalid URL in link", selector, {
            href,
          }),
        );
        return;
      }

      if (abs.hash && options.checkHashes) {
        const withoutHash = abs.href.split("#")[0];
        if (withoutHash === pageUrl.split("#")[0]) {
          const targetId = decodeURIComponent(abs.hash.slice(1));
          if (targetId && !doc.getElementById(targetId)) {
            hashIssues.push(
              createIssue(
                "warning",
                "links",
                `Broken hash anchor #${targetId}`,
                selector,
              ),
            );
          }
        }
      }

      if (sameSite(abs.href)) {
        internalLinks.push(abs.href);
      } else {
        externalLinks.push(abs.href);
        if (a.target === "_blank") {
          const rel = (a.getAttribute("rel") || "").toLowerCase();
          if (!rel.includes("noopener") && !rel.includes("noreferrer")) {
            anchorIssues.push(
              createIssue(
                "warning",
                "security/links",
                'target="_blank" without rel="noopener noreferrer"',
                selector,
                { href: abs.href },
              ),
            );
          }
        }
      }
    });

    anchorIssues.forEach((issue) => addIssue(page, issue));
    hashIssues.forEach((issue) => {
      addIssue(page, issue);
      report.summary.brokenHashAnchors++;
    });

    const forms = [...doc.forms];
    forms.forEach((form, idx) => {
      const controls = [
        ...form.querySelectorAll("input, select, textarea"),
      ].filter((el) => el.type !== "hidden");
      const submitButtons = [
        ...form.querySelectorAll('button[type="submit"], input[type="submit"]'),
      ];
      if (!controls.length) {
        addIssue(
          page,
          createIssue(
            "notice",
            "forms",
            `Form #${idx + 1} has no visible controls`,
            getSelector(form),
          ),
        );
      }
      if (!submitButtons.length) {
        addIssue(
          page,
          createIssue(
            "warning",
            "forms",
            `Form #${idx + 1} has no submit button`,
            getSelector(form),
          ),
        );
      }

      controls.forEach((control) => {
        const id = control.id;
        let hasLabel = false;

        if (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`))
          hasLabel = true;
        if (control.closest("label")) hasLabel = true;
        if (attr(control, "aria-label") || attr(control, "aria-labelledby"))
          hasLabel = true;

        if (!hasLabel) {
          addIssue(
            page,
            createIssue(
              "warning",
              "forms/a11y",
              "Form control missing label",
              getSelector(control),
              {
                name: attr(control, "name"),
                type: attr(control, "type"),
                placeholder: attr(control, "placeholder"),
              },
            ),
          );
          report.summary.formsMissingLabels++;
        }

        if (control.matches("[required]") && !attr(control, "name")) {
          addIssue(
            page,
            createIssue(
              "warning",
              "forms",
              "Required control missing name attribute",
              getSelector(control),
            ),
          );
        }

        if (
          control.type === "email" &&
          control.hasAttribute("required") &&
          !attr(control, "autocomplete")
        ) {
          addIssue(
            page,
            createIssue(
              "notice",
              "forms/ux",
              'Required email field missing autocomplete="email"',
              getSelector(control),
            ),
          );
        }
      });
    });

    const buttons = [
      ...doc.querySelectorAll(
        "button, input[type='button'], input[type='submit'], input[type='reset']",
      ),
    ];
    buttons.forEach((btn) => {
      const name =
        textOf(btn) ||
        attr(btn, "value") ||
        attr(btn, "aria-label") ||
        attr(btn, "title");
      if (!name) {
        addIssue(
          page,
          createIssue(
            "warning",
            "a11y/buttons",
            "Button missing accessible name",
            getSelector(btn),
          ),
        );
        report.summary.buttonsMissingNames++;
      }
    });

    const tables = [...doc.querySelectorAll("table")];
    tables.forEach((table) => {
      const hasTh = table.querySelector("th");
      if (!hasTh) {
        addIssue(
          page,
          createIssue(
            "notice",
            "tables/a11y",
            "Table has no <th> headers",
            getSelector(table),
          ),
        );
      }
    });

    const videos = [...doc.querySelectorAll("video")];
    videos.forEach((video) => {
      const tracks = [
        ...video.querySelectorAll(
          'track[kind="captions"], track[kind="subtitles"]',
        ),
      ];
      if (!tracks.length) {
        addIssue(
          page,
          createIssue(
            "notice",
            "media/a11y",
            "Video has no captions/subtitles track",
            getSelector(video),
          ),
        );
      }
    });

    const iframes = [...doc.querySelectorAll("iframe")];
    iframes.forEach((frame) => {
      if (!attr(frame, "title")) {
        addIssue(
          page,
          createIssue(
            "notice",
            "a11y/iframe",
            "Iframe missing title",
            getSelector(frame),
            { src: frame.src },
          ),
        );
      }
    });

    const scripts = [...doc.querySelectorAll("script[src]")].map((s) => s.src);
    const styles = [
      ...doc.querySelectorAll('link[rel="stylesheet"][href]'),
    ].map((l) => l.href);
    const duplicateScripts = scripts.filter(
      (src, i, arr) => arr.indexOf(src) !== i,
    );
    const duplicateStyles = styles.filter(
      (href, i, arr) => arr.indexOf(href) !== i,
    );

    if (duplicateScripts.length) {
      addIssue(
        page,
        createIssue(
          "warning",
          "performance/scripts",
          "Duplicate script includes found",
          null,
          unique(duplicateScripts),
        ),
      );
    }
    if (duplicateStyles.length) {
      addIssue(
        page,
        createIssue(
          "warning",
          "performance/styles",
          "Duplicate stylesheet includes found",
          null,
          unique(duplicateStyles),
        ),
      );
    }

    const mixedContent = [
      ...images.map((i) => i.src),
      ...anchors.map((a) => a.href),
      ...scripts,
      ...styles,
      ...iframes.map((i) => i.src),
    ]
      .filter(Boolean)
      .filter((u) => /^http:\/\//i.test(u) && location.protocol === "https:");
    if (mixedContent.length) {
      addIssue(
        page,
        createIssue(
          "error",
          "security",
          "Mixed content resources found on HTTPS page",
          null,
          unique(mixedContent).slice(0, 20),
        ),
      );
    }

    const ogTags = {
      "og:title": doc.querySelector('meta[property="og:title"]')?.content || "",
      "og:description":
        doc.querySelector('meta[property="og:description"]')?.content || "",
      "og:image": doc.querySelector('meta[property="og:image"]')?.content || "",
      "og:url": doc.querySelector('meta[property="og:url"]')?.content || "",
      "twitter:card":
        doc.querySelector('meta[name="twitter:card"]')?.content || "",
    };

    if (
      !ogTags["og:title"] ||
      !ogTags["og:description"] ||
      !ogTags["og:image"]
    ) {
      addIssue(
        page,
        createIssue(
          "notice",
          "social/seo",
          "Missing some Open Graph tags",
          null,
          ogTags,
        ),
      );
    }

    const schemaScripts = [
      ...doc.querySelectorAll('script[type="application/ld+json"]'),
    ];
    if (!schemaScripts.length) {
      addIssue(
        page,
        createIssue(
          "notice",
          "structured-data",
          "No JSON-LD structured data found",
        ),
      );
      report.summary.pagesWithStructuredDataIssues++;
    } else {
      schemaScripts.forEach((s, i) => {
        const parsed = safeParseJson(s.textContent.trim());
        if (!parsed.ok) {
          addIssue(
            page,
            createIssue(
              "warning",
              "structured-data",
              `Invalid JSON-LD at block ${i + 1}`,
              getSelector(s),
              { error: parsed.error },
            ),
          );
          report.summary.pagesWithStructuredDataIssues++;
        }
      });
    }

    const noscript = doc.querySelector("noscript");
    if (!noscript) {
      addIssue(
        page,
        createIssue("notice", "resilience", "No <noscript> fallback found"),
      );
    }

    const mainEl = doc.querySelector("main");
    if (!mainEl) {
      addIssue(
        page,
        createIssue("notice", "a11y/landmarks", "No <main> landmark found"),
      );
    }

    const skipLink = [...doc.querySelectorAll('a[href^="#"]')].find((a) => {
      const txt = textOf(a).toLowerCase();
      return txt.includes("skip");
    });
    if (!skipLink) {
      addIssue(
        page,
        createIssue("notice", "a11y/navigation", "No visible skip link found"),
      );
    }

    const emptyParagraphs = [...doc.querySelectorAll("p")].filter(
      (p) => !textOf(p) && !p.querySelector("img,svg,video,iframe"),
    );
    if (emptyParagraphs.length > 3) {
      addIssue(
        page,
        createIssue(
          "notice",
          "content/html",
          `${emptyParagraphs.length} empty paragraphs found`,
        ),
      );
    }

    page.metrics = {
      images: images.length,
      links: anchors.length,
      internalLinks: unique(internalLinks).length,
      externalLinks: unique(externalLinks).length,
      forms: forms.length,
      buttons: buttons.length,
      tables: tables.length,
      videos: videos.length,
      iframes: iframes.length,
      headings: headings.length,
      scripts: scripts.length,
      stylesheets: styles.length,
      duplicateIds: duplicateIds.length,
    };

    page.extracted = {
      lang,
      title,
      metaDescription: metaDescContent,
      canonical: canonicalHref,
      robots,
      h1s: h1s.map((h) => textOf(h)),
      internalLinks: unique(internalLinks),
      externalLinks: unique(externalLinks),
    };

    return page;
  }

  async function inspectPage(url, depth) {
    log(`Scanning: ${url}`);
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch (e) {
      const page = {
        url,
        status: 0,
        ok: false,
        contentType: "",
        issues: [
          createIssue("error", "network", `Failed to fetch page: ${e.message}`),
        ],
        metrics: {},
        extracted: {},
      };
      report.pages.push(page);
      report.summary.brokenLinks++;
      return;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      const page = {
        url,
        status: res.status,
        ok: res.ok,
        contentType,
        issues: [],
        metrics: {},
        extracted: {},
      };
      if (!res.ok) {
        addIssue(
          page,
          createIssue(
            "error",
            "network",
            `Non-OK response: ${res.status} ${res.statusText}`,
          ),
        );
        report.summary.brokenLinks++;
      } else {
        addIssue(
          page,
          createIssue(
            "notice",
            "content-type",
            `Skipped non-HTML content type: ${contentType}`,
          ),
        );
      }
      report.pages.push(page);
      return;
    }

    const html = await res.text();
    const doc = parseHTML(html);
    const page = analyzeDocument(doc, url, {
      status: res.status,
      ok: res.ok,
      contentType,
    });

    if (!res.ok) {
      addIssue(
        page,
        createIssue(
          "error",
          "network",
          `Non-OK response: ${res.status} ${res.statusText}`,
        ),
      );
      report.summary.brokenLinks++;
    }

    report.pages.push(page);

    if (depth < options.maxDepth && report.pages.length < options.maxPages) {
      const linksToQueue = page.extracted.internalLinks
        .filter((link) => isHttpLike(link))
        .filter((link) => !isProbablyBinaryResource(link));

      linksToQueue.forEach((link) => addToQueue(link, depth + 1));
    }
  }

  function summarizePage(page) {
    const counts = {
      error: page.issues.filter((i) => i.type === "error").length,
      warning: page.issues.filter((i) => i.type === "warning").length,
      notice: page.issues.filter((i) => i.type === "notice").length,
    };
    return counts;
  }

  async function validateDiscoveredLinks() {
    const internal = unique(
      report.pages.flatMap((p) => p.extracted?.internalLinks || []),
    ).filter((url) => isHttpLike(url));

    const external = unique(
      report.pages.flatMap((p) => p.extracted?.externalLinks || []),
    ).filter((url) => isHttpLike(url));

    log("Validating internal links...");
    for (const url of internal.slice(0, 200)) {
      const result = await validateLink(url);
      if (!result.ok) {
        report.summary.brokenLinks++;
        report.pages.push({
          url,
          status: result.status,
          ok: false,
          contentType: "",
          issues: [
            createIssue(
              "error",
              "links",
              `Broken internal link: ${result.status} ${result.statusText}`,
            ),
          ],
          metrics: {},
          extracted: {},
        });
      }
    }

    if (options.testExternalLinks) {
      log("Validating sampled external links...");
      const sample = external.slice(0, options.externalLinkSampleSize);
      for (const url of sample) {
        const result = await validateLink(url);
        if (!result.ok) {
          report.pages.push({
            url,
            status: result.status,
            ok: false,
            contentType: "",
            issues: [
              createIssue(
                "warning",
                "links",
                `Broken external link: ${result.status} ${result.statusText}`,
              ),
            ],
            metrics: {},
            extracted: {},
          });
        }
      }
    }
  }

  function printSummary() {
    const pageSummaries = report.pages
      .map((p) => {
        const c = summarizePage(p);
        return {
          url: p.url,
          status: p.status,
          errors: c.error,
          warnings: c.warning,
          notices: c.notice,
        };
      })
      .sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings));

    console.group(
      "%cWebsite Audit Summary",
      "font-weight:bold;font-size:14px;",
    );
    console.log("Base URL:", report.baseUrl);
    console.log("Started At:", report.startedAt);
    console.log("Pages Scanned:", report.summary.pagesVisited);
    console.log("Errors:", report.summary.totalErrors);
    console.log("Warnings:", report.summary.totalWarnings);
    console.log("Notices:", report.summary.totalNotices);
    console.log("Broken Links:", report.summary.brokenLinks);
    console.log("Broken Hash Anchors:", report.summary.brokenHashAnchors);
    console.log("Images Missing Alt:", report.summary.imagesMissingAlt);
    console.log(
      "Form Controls Missing Labels:",
      report.summary.formsMissingLabels,
    );
    console.log("Buttons Missing Names:", report.summary.buttonsMissingNames);
    console.log("Duplicate IDs:", report.summary.duplicateIds);
    console.log("Pages With No H1:", report.summary.pagesWithNoH1);
    console.log("Pages With Multiple H1:", report.summary.pagesWithMultiH1);
    console.log(
      "Pages With Title Issues:",
      report.summary.pagesWithTitleIssues,
    );
    console.log(
      "Pages With Description Issues:",
      report.summary.pagesWithDescriptionIssues,
    );
    console.log(
      "Pages With Canonical Issues:",
      report.summary.pagesWithCanonicalIssues,
    );
    console.log("Pages With Lang Issues:", report.summary.pagesWithLangIssues);
    console.log(
      "Pages With Viewport Issues:",
      report.summary.pagesWithViewportIssues,
    );
    console.log(
      "Pages With Structured Data Issues:",
      report.summary.pagesWithStructuredDataIssues,
    );
    if (report.performance.currentPage) {
      console.log("Current Page Performance:", report.performance.currentPage);
    }
    console.table(pageSummaries);
    console.groupEnd();
  }

  collectCurrentPagePerf();

  if (options.customUrls.length) {
    options.customUrls.forEach((url) => addToQueue(url, 0));
  } else {
    addToQueue(location.href, 0);
  }

  report.summary.pagesQueued = crawlQueue.length;

  while (crawlQueue.length && visited.size < options.maxPages) {
    const next = crawlQueue.shift();
    queued.delete(next.url);
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    await inspectPage(next.url, next.depth);
  }

  report.summary.pagesVisited = visited.size;

  await validateDiscoveredLinks();

  report.finishedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - startTime);

  window.__websiteAuditReport = report;

  printSummary();

  log("Audit complete.");
  log("Full report saved to window.__websiteAuditReport");
  log("You can copy it with: copy(window.__websiteAuditReport)");

  return report;
}