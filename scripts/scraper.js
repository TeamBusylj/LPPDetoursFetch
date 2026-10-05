import fsPromises from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import crypto from 'crypto';
import * as cheerio from 'cheerio';

async function main() {
  const DETOUR_URL = "https://www.lpp.si/javni-prevoz/obvozi";

  try {
    const response = await fetch(DETOUR_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await response.text();
    const data = await parseDetours(html);

    await fsPromises.writeFile("opozorila.json", JSON.stringify(data, null, 2), "utf-8");
    console.log("Opozorila uspešno posodobljena in shranjena!");
  } catch (error) {
    console.error("Napaka pri scrapanju:", error);
    process.exit(1);
  }
}

async function parseDetours(html) {
  const detoursList = [];
  const allLinesSet = new Set();
  const $ = cheerio.load(html);
  const detourItems = [];

  // Pridobivanje seznama obvozov iz novih kartic
  $('article[data-component="mol-article-card"]').each((i, el) => {
    let href = $(el).find('a.stretched-link').attr('href');
    const title = $(el).find('.article-card__title').text().trim();
    const date = $(el).find('.article-card__date').text().trim();

    if (href && title) {
      if (!href.startsWith('http')) {
        href = href.startsWith('/') ? 'https://www.lpp.si' + href : 'https://www.lpp.si/' + href;
      }
      detourItems.push({ href, title, date });
    }
  });

  for (const item of detourItems) {
    const { href, title, date } = item;
    
    const lines = extractLines(title);
    lines.forEach((line) => allLinesSet.add(line));

    let detailHtml = "<p>Vsebine ni mogoče naložiti.</p>";
    try {
      const detailResponse = await fetch(href, { headers: { "User-Agent": "Mozilla/5.0" } });
      const rawDetailHtml = await detailResponse.text();
      const $detail = cheerio.load(rawDetailHtml);

      if (!existsSync('slike')) {
        mkdirSync('slike');
      }

      // Odstranimo nepotrebne elemente
      $detail('script, style, iframe, form').remove();
      
      // Obdelava slik
      $detail('img').each((i, el) => {
        const src = $detail(el).attr('src');
        
        if (src) {
          if (src.startsWith('data:image')) {
            try {
              const matches = src.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];

                const hash = crypto.createHash('md5').update(base64Data).digest('hex');
                const filename = `${hash}.${extension}`;
                const buffer = Buffer.from(base64Data, 'base64');
                
                writeFileSync(`slike/${filename}`, buffer);

                // Zamenjaj z dejanskim GitHub URL-jem repozitorija
                const githubRawUrl = `https://raw.githubusercontent.com/TeamBusylj/LPPDetoursFetch/main/slike/${filename}`;
                $detail(el).attr('src', githubRawUrl);
              } else {
                $detail(el).remove();
              }
            } catch (e) {
              console.error("Napaka pri shranjevanju Base64 slike:", e);
              $detail(el).remove();
            }
          } else if (src.startsWith('/')) {
            $detail(el).attr('src', 'https://www.lpp.si' + src);
          }
          
          $detail(el).removeAttr('style').removeAttr('class').removeAttr('width').removeAttr('height').removeAttr('data-src');
        }
      });

      // Zajem prave vsebine obvoza
      let content = $detail('.editor-text').html();
      if (!content) {
        content = $detail('.content-module__middle').html() \vert{}\vert{}$detail('main').html() || $detail('article').html() \vert{}\vert{}$detail('body').html();
      }

      if (content) {
         detailHtml = content.trim();
      }

    } catch (e) {
      console.error(`Napaka pri podstrani ${href}:`, e);
    }

    detoursList.push({
      title: title,
      date: date,
      url: href,
      lines: lines,
      contentHtml: detailHtml,
    });
  }

  const allLinesSorted = Array.from(allLinesSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  return { detours: detoursList, allLines: allLinesSorted };
}

function extractLines(title) {
  const prefixPattern = /linij[ea]?\s+(.*?)(?:\s+(?:na|v|zaradi|pri|ob)\s+|$)/i;
  const match = prefixPattern.exec(title);
  if (!match) return [];
  const linesSegment = match[1];
  const lineCodePattern = /\b([Nn]?\d+[A-Za-z]?)\b/g;
  const foundLines = [];
  let lineMatch;
  while ((lineMatch = lineCodePattern.exec(linesSegment)) !== null) {
    foundLines.push(lineMatch[1].toUpperCase());
  }
  return foundLines;
}

main();
