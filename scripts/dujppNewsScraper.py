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
    resp.encoding = 'utf-8'
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    # Explicitno dodamo stran "Aktualno"
    regions = [{'url': 'https://www.dujpp.si/Obvestila.html', 'region': 'aktualno'}]

    # Zajemamo povezave LE iz vsebinskih sekcij (preskočimo meni in nogo)
    content_sections = [
        sec for sec in soup.find_all('section')
        if not any(c in sec.get('class', []) for c in ['menu', 'footer', 'nav'])
    ]

    for sec in content_sections:
        for a in sec.find_all('a', href=True):
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
    resp.encoding = 'utf-8'
    if resp.status_code != 200:
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    news_items = []

    sections = soup.find_all('section')
    for sec in sections:
        sec_id = sec.get('id', '')
        
        # Preskočimo menije in noge strani
        sec_class = sec.get('class', [])
        if any(c in sec_class for c in ['menu', 'footer', 'nav']):
            continue

        # Naslov novice je v <h3> ali <h4>
        title_elem = sec.find(['h3', 'h4'])
        if not title_elem:
            continue

        title = title_elem.get_text(strip=True)
        if not title or len(title) < 3:
            continue

        # Pridobivanje celotnega besedila sekcije za zanesljivo ekstrakcijo datuma
        sec_text = sec.get_text().replace('\xa0', ' ')
        
        # Regex ujame datume kot so: "31. 7. 2026", "(31. 7. 2026)", "31.07.2026"
        date_match = re.search(r'\d{1,2}\.\s*\d{1,2}\.\s*\d{4}', sec_text)
        date_str = date_match.group(0).strip() if date_match else ""

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
    if not date_str:
        return datetime.min 
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

    # Sortiranje vseh novic po datumu (najnovejše na vrhu)
    all_news.sort(key=lambda x: parse_date_for_sorting(x['date']), reverse=True)

    with open('dujpp_news.json', 'w', encoding='utf-8') as f:
        json.dump(all_news, f, ensure_ascii=False, indent=2)

    print(f"Uspešno zajeto {len(all_news)} novic iz regij in strani Aktualno.")

if __name__ == "__main__":
    main()
