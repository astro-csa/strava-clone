# TrailRun

Clon personal de Strava con visualización 3D de rutas sobre relieve real.  
Sin costes. Sin licencias. Sin servidores obligatorios.

## Arquitectura del proyecto

```
strava-clone/
├── app/                        ← PWA (desplegada en GitHub Pages)
│   ├── index.html              
│   ├── style.css               
│   ├── app.js                  
│   ├── sw.js                   ← Service Worker (soporte offline)
│   ├── manifest.json           ← Instalable como app en móvil
│   └── icons/
├── backend/                    ← Scripts Python (ejecución local)
│   ├── requirements.txt
│   ├── process_gpx.py          ← Fase 2: enriquecer GPX con SRTM
│   └── visualize/              ← Fase 3: animación 3D (pendiente)
├── .github/
│   └── workflows/
│       └── deploy.yml          ← CI/CD automático a GitHub Pages
└── README.md
```

## Stack tecnológico

| Componente        | Tecnología              | Coste   |
|-------------------|-------------------------|---------|
| Frontend / PWA    | Vanilla JS + Leaflet    | Gratis  |
| Mapas             | OpenStreetMap           | Gratis  |
| Almacenamiento    | IndexedDB (local)       | Gratis  |
| GPS               | Geolocation API         | Gratis  |
| Hosting           | GitHub Pages            | Gratis  |
| CI/CD             | GitHub Actions          | Gratis  |
| Elevación DEM     | NASA SRTM (dominio público) | Gratis |
| Backend análisis  | Python local            | Gratis  |

## Fase 1 — PWA de tracking (✅ completa)

La app móvil vive en `app/` y se despliega automáticamente en GitHub Pages.

**Funcionalidades:**
- Tracking GPS en tiempo real con mapa Leaflet
- Métricas en vivo: distancia, pace, altitud, desnivel
- Historial de rutas guardado en IndexedDB del dispositivo
- Exportación de rutas en formato **GPX estándar**
- Instalable como app nativa (PWA) en iOS y Android
- Funciona offline tras la primera carga

## Despliegue en GitHub Pages

### Configuración inicial (una sola vez)

1. Ve a **Settings → Pages** en tu repositorio
2. En *Source*, selecciona **GitHub Actions**
3. Haz push a `main` → el workflow `.github/workflows/deploy.yml` despliega automáticamente

La URL de la app será:
```
https://<tu-usuario>.github.io/<nombre-del-repo>/
```

### Actualizar la app

Cualquier push a `main` que modifique archivos en `app/` lanza el redeploy automáticamente. Tiempo típico: ~30 segundos.

## Instalar como app en el móvil

1. Abre la URL de GitHub Pages en el navegador del móvil
2. **Android (Chrome):** menú ⋮ → *Añadir a pantalla de inicio*
3. **iOS (Safari):** botón compartir → *Añadir a pantalla de inicio*

La app se instala con icono propio y funciona sin barra de navegador.

## Exportar GPX y procesarlo (Fase 2)

Tras completar una carrera, exporta el GPX desde la app y procésalo localmente:

```bash
cd backend
pip install -r requirements.txt
python process_gpx.py mi_ruta.gpx
```

## Fase 2 — Procesamiento Python (pendiente)

Script `backend/process_gpx.py` que:
- Parsea el GPX con `gpxpy`
- Enriquece los puntos con elevación real SRTM (NASA, dominio público)
- Calcula pace por segmento, VAM, zonas de esfuerzo
- Exporta GeoJSON listo para la visualización 3D

## Fase 3 — Visualización 3D (pendiente)

Animación del recorrido sobre relieve real con CesiumJS o deck.gl.  
Se añadirá en `backend/visualize/`.
