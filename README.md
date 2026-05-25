# Figma AI Design Assistant

Šis ir Figma spraudnis, kas izmanto Anthropic Claude API, lai palīdzētu automatizēt vairākus UI/UX dizaina uzdevumus Figma vidē.

Spraudnis ir izstrādāts bakalaura darba ietvaros.

Darba autors: Eduards Teteris 

Darba vadītāja: Oksana Ņikiforova

## Funkcijas

| Funkcija | Apraksts |
|---|---|
| **Restyle** | Pārveido atlasīta Figma rāmja krāsas pēc lietotāja teksta komandas, piemēram, `dark mode`, `high contrast` vai `sepia`. Oriģinālais rāmis netiek mainīts — tiek izveidots jauns dublikāts. |
| **Generate Library** | Nolasa atlasīto Figma rāmi un izveido strukturētu `Asset Library` lapu ar komponentēm un krāsu paleti. Ja bibliotēka jau eksistē, tā tiek papildināta bez dublikātu veidošanas. |
| **Generate Screen** | Ģenerē jaunu ekrānformu pēc teksta apraksta, izmantojot komponentes no `Asset Library` lapas. |
| **Generate Journey** | Ģenerē vairākus saistītus ekrānus pēc saraksta, piemēram, `Login → Dashboard → Settings`, un savieno tos ar bultiņām. |

## Kas atrodas projektā?

Projektā ir divas galvenās daļas:

1. **Figma spraudnis**  
   Darbojas Figma vidē un veido vai pārveido elementus darba virsmā.

2. **Node.js serveris**  
   Darbojas lokāli datorā un nosūta pieprasījumus uz Anthropic Claude API. API atslēga tiek glabāta servera pusē, nevis Figma spraudnī.

Vienkāršota arhitektūra:

```text
Figma spraudnis  →  Node.js serveris  →  Claude API
```

## Projekta failu struktūra

```text
.
├── code.ts              Galvenais Figma spraudņa fails
├── code.js              Sakompilēts JavaScript fails
├── ui.html              Spraudņa lietotāja saskarne
├── manifest.json        Figma spraudņa konfigurācijas fails
├── tsconfig.json        TypeScript konfigurācija
├── package.json         Projekta komandas un atkarības
├── backend/
│   ├── server.js        Node.js serveris
│   ├── .env             Claude API atslēga
│   └── package.json     Servera atkarības
└── diagrams/            Diagrammas bakalaura darbam
```

## Kas nepieciešams pirms palaišanas?

Pirms spraudņa palaišanas nepieciešams:

- instalēts **Node.js**;
- pieejama **Anthropic Claude API atslēga**;
- piekļuve **Figma** videi;
- lejupielādēts šis projekts.

Claude API atslēgu var iegūt Anthropic Console vidē.

## Kā palaist projektu?

### 1. Instalēt projekta atkarības

Galvenajā projekta mapē jāizpilda:

```bash
npm install
```

Pēc tam jāinstalē servera atkarības:

```bash
cd backend
npm install
cd ..
```

### 2. Pievienot Claude API atslēgu

Mapē `backend` jāizveido fails:

```text
.env
```

Failā jāievieto sava Claude API atslēga:

```text
CLAUDE_API_KEY=sk-ant-...
```

Svarīgi: `.env` failu nedrīkst publicēt GitHub vai citos publiskos repozitorijos.

### 3. Sakompilēt Figma spraudni

Galvenajā projekta mapē jāizpilda:

```bash
npm run build
```

Šī komanda pārveido `code.ts` failu par `code.js`, ko Figma spēj palaist.

Izstrādes laikā var izmantot arī:

```bash
npm run watch
```

### 4. Palaist serveri

Jāatver `backend` mape:

```bash
cd backend
```

Pēc tam jāpalaiž serveris:

```bash
npm start
```

Serveris darbosies adresē:

```text
http://localhost:3000
```

Terminālis ar palaisto serveri ir jāatstāj atvērts, kamēr tiek lietots spraudnis.

### 5. Pievienot spraudni Figma vidē

Figma vidē jāveic šādas darbības:

1. jāatver jebkurš Figma fails;
2. jāizvēlas **Plugins → Development → Import plugin from manifest...**;
3. jāizvēlas projekta fails `manifest.json`;
4. pēc importēšanas spraudni var palaist no **Plugins → Development** sadaļas.

## Kā lietot spraudni?

### Restyle

1. Figma vidē atlasa rāmi.
2. Spraudnī ievada komandu, piemēram:

```text
dark mode
```

vai

```text
high contrast
```

3. Spraudnis izveido jaunu pārveidotu rāmja versiju blakus oriģinālam.

### Generate Library

1. Figma vidē atlasa rāmi.
2. Spraudnī nospiež **Generate Asset Library**.
3. Spraudnis izveido jaunu lapu `Asset Library`.
4. Šajā lapā tiek ievietotas komponentes, kategorijas un krāsu palete.

### Generate Screen

1. Vispirms jāizveido `Asset Library`.
2. Spraudnī jāievada ekrāna apraksts, piemēram:

```text
login screen
```

vai

```text
settings screen
```

3. Spraudnis ģenerē jaunu ekrānformu, izmantojot `Asset Library` lapā esošās komponentes.

### Generate Journey

Spraudnī jāievada vairāki ekrānu nosaukumi, piemēram:

```text
Login → Dashboard → Settings
```

Spraudnis ģenerē vairākus ekrānus un savieno tos ar bultiņām.

## Svarīgi ierobežojumi

- Katram lietotājam nepieciešama sava Anthropic Claude API atslēga.
- Node.js serverim jābūt palaistam lokāli, citādi spraudnis nevarēs sazināties ar Claude API.
- Ģenerētie rezultāti ne vienmēr ir pilnībā gatavi gala lietošanai, tāpēc tos vēlams pārbaudīt un nepieciešamības gadījumā manuāli pielāgot.
- Lietotāja ceļa ekrāni tiek ģenerēti atsevišķi, tāpēc starp ekrāniem var būt nelielas atšķirības.
- Spraudnis ir prototips, nevis pilnībā pabeigts komerciāls produkts.

## Licence

MIT licence.