import json
import re
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.dujpp.si/informacije-za-potnika.html"

def get_region_links():
    resp = requests.get(BASE_URL)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    regions = []
    # Poišče vse povezave do regij v vsebinski sekciji
    for a in soup.find_all('a', href=True):
        href = a['href']
        if href.endswith('.html') and 'informacije-za-potnika' not in href and 'index' not in href:
            full_url = urljoin(BASE_URL, href)
            # Pridobi ime regije (npr. "osrednjeslovenska")
            region_name = a.get_text(strip=True).lower().replace("regija", "").strip()
            
            if not any(r['url'] == full_url for r in regions):
                regions.append({'url': full_url, 'region': region_name})
    return regions

def scrape_region_news(region_info):
    resp = requests.get(region_info['url'])
    if resp.status_code != 200:
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    news_items = []

    # Vsak blok novice se nahaja v <section> elementu z unikaten id-jem
    sections = soup.find_all('section')
    for sec in sections:
        sec_id = sec.get('id', '')
        title_elem = sec.find('h3', class_=lambda c: c and 'mbr-section-title' in c)

        if title_elem:
            title = title_elem.get_text(strip=True)

            # Izvleček datuma (išče vzorec DD. MM. YYYY ali DD.MM.YYYY v odstavku)
            p_elem = sec.find('p', class_=lambda c: c and 'mbr-text' in c)
            date_str = ""
            if p_elem:
                date_match = re.search(r'\d{1,2}\.\s*\d{1,2}\.\s*\d{4}', p_elem.get_text())
                if date_match:
                    date_str = date_match.group(0)

            # Sestavljanje točnega URL-ja s pomočjo ID-ja sekcije
            news_url = f"{region_info['url']}#{sec_id}" if sec_id else region_info['url']

            news_items.append({
                "title": title,
                "date": date_str,
                "region": region_info['region'],
                "source": "DUJPP",
                "url": news_url
            })

    return news_items

def main():
    regions = get_region_links()
    all_news = []

    for reg in regions:
        news = scrape_region_news(reg)
        all_news.extend(news)

    # Shranjevanje v JSON datoteko
    with open('dujpp_news.json', 'w', encoding='utf-8') as f:
        json.dump(all_news, f, ensure_ascii=False, indent=2)

    print(f"Skupno poskrabanih novic: {len(all_news)}")

if __name__ == "__main__":
    main()
