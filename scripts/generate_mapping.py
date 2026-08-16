import os
import io
import shutil
import zipfile
import requests
import pandas as pd
import numpy as np
import unicodedata

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

def is_valid_line(route_name):
    """Preveri, ali linija ustreza pogojem."""
    target_lines = ['3B', '3G', '6B', '12D', '15', '19', '19I', '21D', '25']
    route_name = str(route_name).strip()
    if route_name in target_lines:
        return True
    if route_name.isdigit() and int(route_name) >= 30:
        return True
    return False

def main():
    # 1. Prenos podatkov
    download_and_extract(LPP_URL, LPP_DIR)
    download_and_extract(IJPP_URL, IJPP_DIR)

    print("Nalagam datoteke v pomnilnik...")
    lpp_stops = pd.read_csv(os.path.join(LPP_DIR, 'stops.txt'))
    lpp_routes = pd.read_csv(os.path.join(LPP_DIR, 'routes.txt'))
    lpp_trips = pd.read_csv(os.path.join(LPP_DIR, 'trips.txt'))
    
    # Preberemo samo potrebne stolpce, da zmanjšamo porabo pomnilnika
    lpp_stop_times = pd.read_csv(os.path.join(LPP_DIR, 'stop_times.txt'), usecols=['trip_id', 'stop_id'])
    ijpp_stops = pd.read_csv(os.path.join(IJPP_DIR, 'stops.txt'))

    # 2. Filtriranje linij
    print("Filtriram LPP linije...")
    lpp_routes['is_target'] = lpp_routes['route_short_name'].apply(is_valid_line)
    valid_routes = lpp_routes[lpp_routes['is_target']]['route_id'].tolist()

    valid_trips = lpp_trips[lpp_trips['route_id'].isin(valid_routes)]['trip_id'].tolist()
    valid_stops = lpp_stop_times[lpp_stop_times['trip_id'].isin(valid_trips)]['stop_id'].unique()
    
    filtered_lpp_stops = lpp_stops[lpp_stops['stop_id'].isin(valid_stops)].copy()
    print(f"Najdenih {len(filtered_lpp_stops)} LPP postaj na izbranih linijah.")

    # 3. Normalizacija in iskanje dvojnikov
    filtered_lpp_stops['norm_name'] = filtered_lpp_stops['stop_name'].apply(normalize_string)
    ijpp_stops['norm_name'] = ijpp_stops['stop_name'].apply(normalize_string)

    results = []
    print("Iščem IJPP dvojnike (radij 100m)...")
    
    for _, lpp_row in filtered_lpp_stops.iterrows():
        # Izračun razdalj
        distances = haversine(
            lpp_row['stop_lat'], lpp_row['stop_lon'], 
            ijpp_stops['stop_lat'].values, ijpp_stops['stop_lon'].values
        )
        
        ijpp_stops['distance_m'] = distances
        nearby_ijpp = ijpp_stops[ijpp_stops['distance_m'] <= 100].copy()
        
        if nearby_ijpp.empty:
            continue
            
        name_matches = nearby_ijpp[nearby_ijpp['norm_name'] == lpp_row['norm_name']]
        best_match = None
        
        if not name_matches.empty:
            best_match = name_matches.sort_values(by='distance_m').iloc[0]
        else:
            very_close = nearby_ijpp[nearby_ijpp['distance_m'] <= 30]
            if not very_close.empty:
                best_match = very_close.sort_values(by='distance_m').iloc[0]
                
        if best_match is not None:
            results.append({
                'lpp_stop_id': lpp_row['stop_id'],
                'lpp_stop_name': lpp_row['stop_name'],
                'ijpp_stop_id': best_match['stop_id'],
                'ijpp_stop_name': best_match['stop_name'],
                'distance_m': round(best_match['distance_m'], 1)
            })

    # 4. Izvoz in čiščenje
    df_results = pd.DataFrame(results)
    output_file = 'lpp_ijpp_mapping.csv'
    df_results.to_csv(output_file, index=False)
    print(f"Končano! Mapiranih {len(df_results)} postaj. Shranjeno v '{output_file}'.")

    shutil.rmtree(LPP_DIR, ignore_errors=True)
    shutil.rmtree(IJPP_DIR, ignore_errors=True)

if __name__ == "__main__":
    main()
