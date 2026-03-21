import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs'; // Za ustvarjanje mape
import crypto from 'crypto'; // Za generiranje edinstvenih imen slik
import * as cheerio from 'cheerio';

async function main() {
  const DETOUR_URL = "https://www.lpp.si/javni-prevoz/obvozi"; // Brez CORS proxyja!

  try {
    const response = await fetch(DETOUR_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await response.text();
    const data = await parseDetours(html);

    // Shranimo v datoteko
    await fs.writeFile("opozorila.json", JSON.stringify(data, null, 2), "utf-8");
    console.log("Opozorila uspešno posodobljena in shranjena!");
  } catch (error) {
    console.error("Napaka pri scrapanju:", error);
    process.exit(1);
  }
}

async function parseDetours(html) {
  const detoursList = [];
  const allLinesSet = new Set();
  const detourPattern = /<div class="content__box--title"><a href="(.*)">(.*)<\/a><\/div>[\s\S]*?<div class="content__box--date">(.*)<\/div>/g;

  let match;
  while ((match = detourPattern.exec(html)) !== null) {
    const href = "https://www.lpp.si" + match[1].trim();
    const title = match[2].trim();
    const date = match[3].trim();
    const lines = extractLines(title);
    lines.forEach((line) => allLinesSet.add(line));

    // Tukaj je GLAVNI TRIK: Takoj prenesemo še podstran obvoza!
    let detailHtml = "<p>Vsebine ni mogoče naložiti.</p>";
    try {
      const detailResponse = await fetch(href, { headers: { "User-Agent": "Mozilla/5.0" } });
      const rawDetailHtml = await detailResponse.text();
      const $ = cheerio.load(rawDetailHtml);

      // Odstranimo nepotrebne elemente (isto kot tvoj prejšnji jQuery/DOMParser)
      $(".main--title").remove();
      $(".content__share--wrapper").remove();

      // Ustvarimo mapo "slike", če še ne obstaja
      if (!existsSync('slike')) {
        mkdirSync('slike');
      }

      // Odstranimo nepotrebne elemente
      $('.main--title').remove();
      $('.content__share--wrapper').remove();
      $('script, style, iframe, form').remove();
      
      // Pametna obdelava slik
      $('img').each((i, el) => {
        const src = $(el).attr('src');
        
        if (src) {
          if (src.startsWith('data:image')) {
            try {
              // 1. Izluščimo tip slike in same podatke
              const matches = src.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                const mimeType = matches[1]; // npr. image/jpeg
                const base64Data = matches[2];
                // Določimo končnico (.jpg, .png...)
                const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];

                // 2. Ustvarimo unikatno ime datoteke glede na njeno vsebino
                const hash = crypto.createHash('md5').update(base64Data).digest('hex');
                const filename = `${hash}.${extension}`;

                // 3. Shranimo sliko fizično v mapo "slike"
                const buffer = Buffer.from(base64Data, 'base64');
                // Uporabimo sinhrono pisanje (samo za to podrobnost), ker smo znotraj cheerio zanke
                import('fs').then(fsSync => fsSync.writeFileSync(`slike/${filename}`, buffer));

                // 4. ZAMENJAJ TUKAJ: Vstavi svoj pravi GitHub username in ime repozitorija!
                const githubRawUrl = `https://raw.githubusercontent.com/TeamBusylj/LPPDetoursFetch/main/slike/${filename}`;
                
                // 5. V HTML-ju zamenjamo Base64 pošast s tem lepim, kratkim GitHub URL-jem
                $(el).attr('src', githubRawUrl);
              } else {
                $(el).remove(); // Če je format čuden, jo raje brišemo
              }
            } catch (e) {
              console.error("Napaka pri shranjevanju Base64 slike:", e);
              $(el).remove();
            }
          } else if (src.startsWith('/')) {
            // Normalne relativne slike
            $(el).attr('src', 'https://www.lpp.si' + src);
          }
          
          $(el).removeAttr('style').removeAttr('class').removeAttr('width').removeAttr('height');
        }
      });

      // Vzamemo prečiščen HTML z novimi slikovnimi URL-ji
      detailHtml = $('#content').html() || detailHtml;

      // Vzamemo samo vsebino in jo očistimo
      detailHtml = $("#content").html() || detailHtml;
    } catch (e) {
      console.error(`Napaka pri podstrani ${href}:`, e);
    }

    detoursList.push({
      title: title,
      date: date,
      url: href,
      lines: lines,
      contentHtml: detailHtml, // To zdaj vsebuje celotno besedilo in obvestila!
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
