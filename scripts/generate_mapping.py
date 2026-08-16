import os
import io
import shutil
import zipfile
import requests
import pandas as pd
import numpy as np
import unicodedata
import json
import re

# Poti do začasnih map
LPP_DIR = 'temp_lpp_gtfs'
IJPP_DIR = 'temp_ijpp_gtfs'

LPP_URL = 'https://gitlab.com/api/v4/projects/derp-si%2Fgtfs-generators/packages/generic/LPP/latest/lpp_gtfs.zip'
IJPP_URL = 'https://gitlab.com/api/v4/projects/derp-si%2Fgtfs-generators/packages/generic/IJPP/latest/ijpp_gtfs.zip'

def download_and_extract(url, extract_to):
    """Prenese ZIP datoteko z URL-ja in jo ekstrahira v ciljno mapo."""
    print(f"Prenašam in ekstrahiram: {url}")
    if os.path.exists(extract_to):
        shutil.rmtree(extract_to)
    os.makedirs(extract_to)
    
    response = requests.get(url, stream=True)
    response.raise_for_status()
    
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        z.extractall(extract_to)

def normalize_string(s):
    """Odstrani šumnike, pretvori v male črke in odstrani presledke."""
    if pd.isna(s):
        return ""
    s = str(s).lower().strip()
    s = ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')
    return s.replace(" ", "")

def haversine(lat1, lon1, lat2, lon2):
    """Izračuna razdaljo v metrih med točkami s pomočjo numpy (vektorizirano)."""
    R = 6371000  # Radij Zemlje v metrih
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    delta_phi = np.radians(lat2 - lat1)
    delta_lambda = np.radians(lon2 - lon1)

    a = np.sin(delta_phi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(delta_lambda / 2.0) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c

def check_line(route_val):
    """Preveri, ali niz ustreza iskani liniji (zelo tolerantno)."""
    if pd.isna(route_val):
        return False
    val_clean = str(route_val).upper().replace(" ", "")
    
    target_lines = ['3B', '3G', '6B', '12D', '15', '19', '19I', '21D', '25']
    
    if val_clean in target_lines:
        return True
    
    # Preverimo, ali je v vrednosti samo številka >= 30
    numbers = re.findall(r'\d+', val_clean)
    for num in numbers:
        if int(num) >= 30:
            return True
            
    return False

def is_valid_line(row):
    """Preveri tako route_short_name kot route_long_name."""
    is_valid = False
    if 'route_short_name' in row and check_line(row['route_short_name']):
        is_valid = True
    if 'route_long_name' in row and check_line(row['route_long_name']):
        is_valid = True
    return is_valid

def main():
    # 1. Prenos podatkov
    download_and_extract(LPP_URL, LPP_DIR)
    download_and_extract(IJPP_URL, IJPP_DIR)

    print("Nalagam datoteke v pomnilnik...")
    
    # Naložimo IJPP podatke za filtriranje linij
    ijpp_stops = pd.read_csv(os.path.join(IJPP_DIR, 'stops.txt'), dtype={'stop_id': str})
    ijpp_routes = pd.read_csv(os.path.join(IJPP_DIR, 'routes.txt'), dtype={'route_id': str})
    ijpp_trips = pd.read_csv(os.path.join(IJPP_DIR, 'trips.txt'), dtype={'route_id': str, 'trip_id': str})
    ijpp_stop_times = pd.read_csv(os.path.join(IJPP_DIR, 'stop_times.txt'), usecols=['trip_id', 'stop_id'], dtype={'trip_id': str, 'stop_id': str})
    
    # Naložimo LPP postaje za iskanje dvojnikov
    lpp_stops = pd.read_csv(os.path.join(LPP_DIR, 'stops.txt'), dtype={'stop_id': str})

    # 2. Filtriranje IJPP linij (ker te linije ne obstajajo več v LPP feedu)
    print("Filtriram IJPP linije...")
    ijpp_routes['is_target'] = ijpp_routes.apply(is_valid_line, axis=1)
    
    valid_routes = ijpp_routes[ijpp_routes['is_target']]['route_id'].tolist()
    print(f"Najdenih IJPP linij, ki ustrezajo kriteriju: {len(valid_routes)}")
    
    if len(valid_routes) == 0:
        print("OPOZORILO: Ni bilo mogoče najti nobene linije. Preverite strukturo datoteke IJPP routes.txt.")
        return

    # Poiščemo ustrezne vožnje in nato ustrezne postaje na teh vožnjah
    valid_trips = ijpp_trips[ijpp_trips['route_id'].isin(valid_routes)]['trip_id'].tolist()
    valid_stops = ijpp_stop_times[ijpp_stop_times['trip_id'].isin(valid_trips)]['stop_id'].unique()
    
    filtered_ijpp_stops = ijpp_stops[ijpp_stops['stop_id'].isin(valid_stops)].copy()
    print(f"Najdenih {len(filtered_ijpp_stops)} IJPP postaj na izbranih linijah.")

    if len(filtered_ijpp_stops) == 0:
         return

    # 3. Normalizacija in iskanje LPP dvojnikov
    filtered_ijpp_stops['norm_name'] = filtered_ijpp_stops['stop_name'].apply(normalize_string)
    lpp_stops['norm_name'] = lpp_stops['stop_name'].apply(normalize_string)

    mapping_dict = {}
    print("Iščem LPP dvojnike (radij 100m)...")
    
    for _, ijpp_row in filtered_ijpp_stops.iterrows():
        # Izračun razdalj od trenutne IJPP postaje do vseh LPP postaj
        distances = haversine(
            ijpp_row['stop_lat'], ijpp_row['stop_lon'], 
            lpp_stops['stop_lat'].values, lpp_stops['stop_lon'].values
        )
        
        lpp_stops['distance_m'] = distances
        nearby_lpp = lpp_stops[lpp_stops['distance_m'] <= 100].copy()
        
        if nearby_lpp.empty:
            continue
            
        # Iskanje ujemanj po normaliziranem imenu
        name_matches = nearby_lpp[nearby_lpp['norm_name'] == ijpp_row['norm_name']]
        best_match = None
        
        if not name_matches.empty:
            best_match = name_matches.sort_values(by='distance_m').iloc[0]
        else:
            very_close = nearby_lpp[nearby_lpp['distance_m'] <= 30]
            if not very_close.empty:
                best_match = very_close.sort_values(by='distance_m').iloc[0]
                
        if best_match is not None:
             ijpp_id = str(ijpp_row['stop_id'])
             lpp_id = str(best_match['stop_id'])
             
             # Preverimo, ali se predpone že nahajajo v nizu, sicer jih dodamo
             if not ijpp_id.startswith('IJPP:'):
                 ijpp_id = f"IJPP:{ijpp_id}"
             if not lpp_id.startswith('LPP:'):
                 lpp_id = f"LPP:{lpp_id}"
                 
             mapping_dict[ijpp_id] = lpp_id

    # 4. Izvoz v JSON in čiščenje
    output_file = 'ijpp_lpp_mapping.json'
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(mapping_dict, f, indent=4)
        
    print(f"Končano! Mapiranih {len(mapping_dict)} postaj. Shranjeno v '{output_file}'.")

    shutil.rmtree(LPP_DIR, ignore_errors=True)
    shutil.rmtree(IJPP_DIR, ignore_errors=True)

if __name__ == "__main__":
    main()