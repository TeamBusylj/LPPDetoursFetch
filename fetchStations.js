import fs from 'fs/promises';

async function fetchStations() {
  const API_URL = "https://data.lpp.si/api/station/station-details";

  try {
    const response = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!response.ok) {
      throw new Error(`HTTP napaka! Status: ${response.status}`);
    }

    const jsonResponse = await response.json();

    // Preverimo, če ključ 'data' obstaja in ga shranimo
    if (jsonResponse.data) {
      await fs.writeFile("lppStations.json", JSON.stringify(jsonResponse.data, null, 2), "utf-8");
      console.log("Postaje uspešno posodobljene in shranjene v lppStations.json!");
    } else {
      throw new Error("Ključa 'data' ni v odgovoru API-ja.");
    }
  } catch (error) {
    console.error("Napaka pri pridobivanju LPP postaj:", error);
    process.exit(1);
  }
}

fetchStations();
