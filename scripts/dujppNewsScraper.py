import json
import re
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup
from datetime import datetime

BASE_URL = "https://www.dujpp.si/informacije-za-potnika.html"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def get_region_links():
    resp = requests.get(BASE_URL, headers=HEADERS)
    resp.encoding = 'utf-8' # Prisili UTF-8 kodiranje za pravilen prikaz šumnikov
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    regions = []
    for a in soup.find_all('a', href=True):
        href = a['href']
        text = a.get_text(strip=True)
        if href.endswith('.html') and 'informacije-za-potnika' not in href and 'index' not in href:
            full_url = urljoin(BASE_URL, href)
            region_name = text.lower().replace("regija", "").strip()
            if not region_name:
                region_name = href.split('/')[-1].replace('.html', '')

            if not any(r['url'] == full_url for r in regions):
                regions.append({'url': full_url, 'region': region_name})
    return regions

def scrape_region_news(region_info):
    resp = requests.get(region_info['url'], headers=HEADERS)
    resp.encoding = 'utf-8' # Prisili UTF-8 kodiranje
    if resp.status_code != 200:
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    news_items = []

    sections = soup.find_all('section')
    print(region_info['region'])
    for sec in sections:
        sec_id = sec.get('id', '')
        
        # Preskoči meni in nogo
        sec_class = sec.get('class', [])
        if any(c in sec_class for c in ['menu', 'footer']):
            continue

        # Išče naslov v <h3> ali <h4> oznakah
        title_elem = sec.find(['h3', 'h4'])
        if not title_elem:
            continue

        title = title_elem.get_text(strip=True)
        if not title:
            continue

        # Izvleček datuma iz odstavka
        p_elem = sec.find('p')
        date_str = ""
        if p_elem:
            full_p_text = p_elem.get_text()
            # Išče vzorec datuma (npr. 15.08.2026 ali 15. 8. 2026)
            date_match = re.search(r'\d{1,2}\.\s*\d{1,2}\.\s*\d{4}', full_p_text)
            if date_match:
                date_str = date_match.group(0)

        news_url = f"{region_info['url']}#{sec_id}" if sec_id else region_info['url']

        news_items.append({
            "title": title,
            "date": date_str,
            "region": region_info['region'],
            "source": "DUJPP",
            "url": news_url
        })

    return news_items

def parse_date_for_sorting(date_str):
    """Pomožna funkcija za pretvorbo stringa v datum za potrebe sortiranja."""
    if not date_str:
        # Če novice nimajo datuma, jih postavimo na konec seznama (najstarejši možen datum)
        return datetime.min 
    
    # Odstranimo presledke za lažje parsanje (npr. "15. 8. 2024" -> "15.8.2024")
    clean_str = date_str.replace(" ", "")
    try:
        return datetime.strptime(clean_str, "%d.%m.%Y")
    except ValueError:
        return datetime.min

def main():
    regions = get_region_links()
    all_news = []

    for reg in regions:
        news = scrape_region_news(reg)
        all_news.extend(news)

    # Sortiranje vseh novic po datumu (padajoče - najnovejše najprej)
    all_news.sort(key=lambda x: parse_date_for_sorting(x['date']), reverse=True)

    # Shranjevanje v JSON datoteko
    with open('dujpp_news.json', 'w', encoding='utf-8') as f:
        json.dump(all_news, f, ensure_ascii=False, indent=2)

    print(f"Uspešno zajeto in po datumu sortirano {len(all_news)} novic.")

if __name__ == "__main__":
    main()
