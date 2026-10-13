# codeshare

Plataforma minimalista para compartir código: sube archivos o carpetas completas y obtén un link corto (`tu-dominio.com/aB3xYz`) donde se ven todos los archivos con resaltado de sintaxis. **Cada proyecto se elimina automáticamente 24 horas después de subirlo.** No hay cuentas ni inicio de sesión.

## Funciones

- Arrastrar y soltar archivos **y carpetas** (conserva la estructura), selector de archivos/carpeta o pegar código directamente.
- Links cortos de 6 caracteres sin caracteres ambiguos (`0/O`, `1/l/I`).
- Visor con árbol de archivos, números de línea, resaltado de sintaxis, modo claro/oscuro automático y diseño adaptable a móvil.
- Copiar contenido, ver *raw*, descargar un archivo o todo el proyecto en `.zip`.
- Vista previa de imágenes; los binarios se ofrecen como descarga.
- **Edición después de crear el link**: editar archivos en el navegador (con resaltado de sintaxis), crear, subir, renombrar y eliminar archivos. Los cambios aparecen solos para quien tenga el proyecto abierto.
- **Permisos sin cuentas**: al crear eliges *Solo yo* o *Cualquiera con el link*. El dueño puede cambiarlo o eliminar el proyecto cuando quiera.
- Borrado automático a las 24 h (configurable) con un barrido cada minuto; además un proyecto vencido nunca se sirve aunque el barrido aún no haya pasado.
- Ignora automáticamente `node_modules`, `.git`, `__pycache__`, `.venv`, etc. al subir carpetas.
- Límites configurables de tamaño y número de archivos, y límite de subidas por IP.

## Edición y permisos

No hay inicio de sesión, así que el permiso de edición se basa en una **clave secreta** por proyecto:

1. Al crear el proyecto el servidor genera una clave aleatoria (192 bits) y solo guarda su hash SHA-256. La clave se le entrega una única vez al creador, dentro de un link privado: `https://tu-dominio/aB3xYz#key=…`.
2. La clave va después del `#`, una parte de la URL que el navegador nunca envía al servidor. Así no queda en logs, proxies ni en el `Referer`. El navegador del creador la guarda en `localStorage` y la manda en la cabecera `X-Edit-Token`.
3. Para editar desde otro dispositivo basta con abrir el link privado. Si se pierde, no se puede recuperar.

| Modo | Ver | Editar archivos | Cambiar modo / eliminar proyecto |
| --- | --- | --- | --- |
| **Solo yo** (por defecto) | cualquiera con el link | solo con la clave | solo con la clave |
| **Cualquiera con el link** | cualquiera con el link | cualquiera con el link | solo con la clave |

Protecciones:

- **Editar no alarga la vida del proyecto**: se borra igual 24 h después de crearlo, así que no puede usarse como alojamiento permanente.
- **Límites**: tamaño y número de archivos se aplican también al editar, y hay un límite de ediciones por IP y hora (`EDITS_PER_HOUR`).
- **Conflictos**: cada archivo tiene una versión; si dos personas guardan a la vez, la segunda recibe un aviso y decide si sobrescribir.
- **CSRF**: la clave viaja en una cabecera propia, que otro sitio no puede enviar sin pasar por CORS (desactivado).
- **Contenido aislado**: lo subido sigue sirviéndose como texto con CSP `sandbox`, sin importar quién lo edite.

## Desplegar con Docker

```bash
docker compose up -d --build
```

La app queda en `http://localhost:3000`. Los archivos se guardan en el volumen `code-share-data`.

Sin compose:

```bash
docker build -t code-share .
docker run -d -p 3000:3000 -v code-share-data:/data --name code-share code-share
```

Detrás de un proxy inverso (nginx, Caddy, Traefik…) define `TRUST_PROXY=true` para que el límite por IP use la IP real del cliente, y `PUBLIC_URL` con tu dominio:

```bash
PUBLIC_URL=https://share.midominio.com TRUST_PROXY=true docker compose up -d --build
```

Si usas nginx, recuerda subir `client_max_body_size` (por ejemplo `client_max_body_size 60m;`).

## Configuración

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP. |
| `DATA_DIR` | `./data` (`/data` en Docker) | Dónde se guardan los proyectos. |
| `PUBLIC_URL` | — | URL base para los links generados. Si está vacía se usa el host de la petición. |
| `TTL_HOURS` | `24` | Horas antes de borrar un proyecto. |
| `ID_LENGTH` | `6` | Longitud del identificador del link. |
| `MAX_FILES` | `100` | Archivos máximos por proyecto. |
| `MAX_FILE_SIZE_MB` | `10` | Tamaño máximo por archivo. |
| `MAX_TOTAL_SIZE_MB` | `50` | Tamaño máximo por proyecto. |
| `UPLOADS_PER_HOUR` | `30` | Proyectos nuevos permitidos por IP y hora. |
| `EDITS_PER_HOUR` | `600` | Ediciones permitidas por IP y hora (guardar, subir, renombrar, eliminar). |
| `SWEEP_INTERVAL_SECONDS` | `60` | Cada cuánto se buscan proyectos vencidos. |
| `TRUST_PROXY` | `false` | Confiar en `X-Forwarded-*` (usar detrás de un proxy inverso). |

## Desarrollo local

Requiere Node.js 20 o superior.

```bash
npm install
npm run dev     # recarga automática
npm test
```

## API

También se puede usar desde la terminal:

```bash
# Subir archivos (devuelve JSON con el link)
curl -F files=@main.py -F files=@utils.py https://share.midominio.com/api/projects

# Editar un archivo con la clave (editToken de la respuesta anterior)
curl -X PUT -H "X-Edit-Token: $KEY" --data-binary @main.py https://share.midominio.com/api/projects/aB3xYz/files/0

# Leer un archivo directamente
curl https://share.midominio.com/aB3xYz/raw/main.py
```

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/api/projects` | Multipart con uno o más campos `files`. Opcionales: `manifest` (arreglo JSON con la ruta relativa de cada archivo, en orden) y `editMode` (`owner` o `anyone`). Devuelve `editToken` y `editUrl`. |
| `GET` | `/api/projects/:id` | Metadatos del proyecto, lista de archivos y permisos (`canEdit`, `isOwner`). |
| `GET` | `/api/projects/:id/files/:fileId` | Contenido de un archivo (`?download` para descargarlo). |
| `POST` | `/api/projects/:id/files` | Añade archivos (multipart, igual que al crear). Requiere permiso de edición. |
| `PUT` | `/api/projects/:id/files/:fileId` | Reemplaza el contenido (cuerpo crudo). Opcional `X-Base-Version` para detectar conflictos (409). |
| `PATCH` | `/api/projects/:id/files/:fileId` | Renombra/mueve: `{"path": "nueva/ruta.js"}`. |
| `DELETE` | `/api/projects/:id/files/:fileId` | Elimina un archivo. |
| `PATCH` | `/api/projects/:id` | Solo dueño: `{"editMode": "owner" \| "anyone"}`. |
| `DELETE` | `/api/projects/:id` | Solo dueño: elimina el proyecto. |
| `GET` | `/api/projects/:id/zip` | Todo el proyecto en `.zip`. |
| `GET` | `/:id/raw/<ruta>` | Contenido de un archivo por su ruta. |
| `GET` | `/healthz` | Estado del servicio. |

## Cómo funciona

- Cada proyecto vive en `DATA_DIR/projects/<id>/` con un `meta.json` y los archivos guardados por un id interno (`files/0`, `files/1`…). Las rutas que envía el usuario solo se usan para mostrar, nunca para escribir en disco, así que no hay forma de salirse del directorio.
- Las escrituras de un mismo proyecto se ejecutan en cola y `meta.json` se reemplaza de forma atómica, así que ediciones simultáneas no se pisan.
- Al arrancar, el servidor lee todos los `meta.json`, borra lo que ya venció y programa el barrido periódico.
- Los archivos se sirven como `text/plain` (o como imagen rasterizada) con `nosniff` y una CSP `sandbox`, por lo que un HTML o SVG subido nunca se ejecuta en el dominio.
