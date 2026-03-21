import fs from "fs/promises";
import * as cheerio from "cheerio";

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
