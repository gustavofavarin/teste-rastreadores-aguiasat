# DO Telematics — Investigação (Fase 1, REVISADA)

Relatório atualizado depois que o cliente passou o fluxo de autenticação real do **api-gateway** (`https://api-gateway.dotelematics.com`), que **difere** do Swagger UI público em `https://api.dotelematics.com/api`. As duas APIs coexistem, mas a oficial para integração é o gateway. Tudo abaixo foi reconfirmado por chamada real.

> **TL;DR do que mudou em relação à v1 deste relatório:**
> 1. Base correta = `https://api-gateway.dotelematics.com` (não `https://api.dotelematics.com`).
> 2. Toda chamada exige `apikey: <DOTELEMATICS_APIKEY>` no header — inclusive o login.
> 3. Login agora devolve `{ data: { access_token, refresh_token } }` (snake_case, dentro de `data`), e o status é **200** (não 201).
> 4. O gateway respeita o filtro `?companies=<id>` no realtime — derruba de 5336 para 1031 trackers (apenas os da nossa empresa). Isso vai poupar muito payload.
> 5. Existe endpoint `/auth/refresh` (com `refresh_token`) — token expira em ~7 dias.
> 6. `/user/me` devolve `companyId._id`, que é o que usamos no filtro acima.

---

## 1. Autenticação

### Headers obrigatórios em TODAS as chamadas

```
apikey: <DOTELEMATICS_APIKEY>          # tenant key, fixa
authorization: Bearer <access_token>   # exceto no login e no refresh
Content-Type: application/json         # quando há corpo
Accept: application/json
```

> **Precisa de uma env nova:** `DOTELEMATICS_APIKEY`. O cliente já me passou o valor no anexo (não vou escrevê-lo em nenhum arquivo deste repo). **Antes da Fase 2, adicione a linha `DOTELEMATICS_APIKEY=<valor>` no seu `.env`** (.env.example terá só placeholder).

### Login

| item    | valor                                                  |
|---------|--------------------------------------------------------|
| método  | `POST`                                                 |
| URL     | `https://api-gateway.dotelematics.com/auth/login`      |
| headers | `apikey`, `Content-Type: application/json`             |

Corpo:

```json
{ "email": "<DOTELEMATICS_USERNAME>", "password": "<DOTELEMATICS_PASSWORD>" }
```

Resposta (status `200`, confirmado):

```json
{
  "data": {
    "access_token": "<JWT, ~356 chars>",
    "refresh_token": "<uuid v4, 36 chars>"
  }
}
```

### Refresh

| item    | valor                                                   |
|---------|---------------------------------------------------------|
| método  | `POST`                                                  |
| URL     | `https://api-gateway.dotelematics.com/auth/refresh`     |
| headers | `apikey`, `Content-Type: application/json`              |

Corpo: `{ "refresh_token": "<uuid>" }`. Resposta: mesmo shape do login.

> Confirmado por chamada real: tanto `access_token` quanto `refresh_token` são **rotacionados** a cada refresh (o refresh antigo deixa de valer). Vou guardar o par atualizado no cache em memória.

### Estratégia de cache na Fase 2

Mesmo padrão do `server/getrak.js`, com refresh extra:

- Em memória: `{ accessToken, refreshToken, expiresAt }`.
- O JWT não traz `expires_in`, mas o anexo diz "a cada 7 dias o token expira". Vou decodificar o JWT (sem verificar assinatura — só `JSON.parse(atob(parts[1]))`) para ler `exp` e usá-lo. Fallback: 6 dias se faltar `exp`.
- Em qualquer 401 vindo do realtime: 1) tenta `/auth/refresh` com o refresh atual; 2) se isso também falhar com 401, refaz `/auth/login` do zero. Tudo isso transparente, espelhando o `authedFetch` do Getrak.

### `/user/me` (opcional mas útil)

| item    | valor                                                |
|---------|------------------------------------------------------|
| método  | `GET`                                                |
| URL     | `https://api-gateway.dotelematics.com/user/me`       |
| headers | `apikey`, `Authorization: Bearer <token>`            |

Devolve um JSON onde nos interessa só `companyId._id` (no nosso caso `63c050cb3c457b0016e705cd` = "AGUIASAT SISTEMAS DE RASTREAMENTO"). Vou chamar uma única vez no primeiro warm-up e cachear na memória do processo; serve como filtro no realtime.

---

## 2. Endpoint v2 de posição em tempo real

| item    | valor                                                                  |
|---------|------------------------------------------------------------------------|
| método  | `GET`                                                                  |
| URL     | `https://api-gateway.dotelematics.com/tracking/realtime/v2`            |
| headers | `apikey`, `Authorization: Bearer <token>`                              |
| query   | `companies=<companyId>` ← **respeitado pelo gateway**                  |

### Diferenças importantes entre os dois hosts (confirmado por chamada)

| comportamento                                       | `api.dotelematics.com`          | `api-gateway.dotelematics.com` |
|----------------------------------------------------|---------------------------------|--------------------------------|
| `apikey` header                                     | não exige                       | **obrigatório**                |
| `?companies=<id>`                                   | ignorado                        | **respeitado**                 |
| `?search` / `?searchKey` / `?limit`                | ignorados                       | ignorados                      |
| total de trackers (sem filtro, este login)         | 5336                            | 5336                           |
| total de trackers com `?companies=<companyId>`     | 5336 (filtro ignorado)          | **1031** (filtro aplicado)     |
| trackers com `packet` no array                      | 5272/5336                       | 5336/5336                      |
| pacote (`packet`) inclui `IS_WAITING_BLOCK`, `SERIAL_CODE` | não                       | **sim**                        |

**Implicação:** vamos usar o gateway com `?companies=<companyId>` — payload ~5x menor e cobertura idêntica. `search`/`limit` continuam não funcionando, então mantemos o padrão snapshot + filtro local.

### Shape REAL (gateway, filtrado pela nossa company)

Array puro de objetos:

```jsonc
{
  "_id": "6712ba2e652db510a910a490",      // ObjectId do tracker
  "did": 355322094280939,                  // IMEI numérico
  "name": "QIB0G60 - RODRIGO MARTINELLO BACK",
  "canBeBlocked": false,
  "vehicle": {
    "_id": "6712ba7c0c38013361427a83",
    "name": "QIB0G60 - RODRIGO MARTINELLO BACK",
    "plate": "QIB0G60",
    "type": { "_id": "...", "icon": "mat_outline:directions_car" },
    "fleets": []
  },
  "company": { "_id": "63c050cb...", "name": "AGUIASAT SISTEMAS DE RASTREAMNETO" },
  "driver":  { "_id": "...", "name": "" },
  "packet": {
    "DID":              0,                              // pode vir zerado; preferir doc.did
    "GPS_TIME":         "2026-05-19T13:04:03Z",         // ISO UTC — última posição do GPS
    "SERVER_TIME":      "2026-05-19T13:04:05.08Z",      // ISO UTC — recepção no servidor
    "LATITUDE":         -28.665518333333335,
    "LONGITUDE":        -49.33813888888889,
    "VEHICLE_VOLTAGE":  12090,                           // milivolts (12090 mV = 12.09 V)
    "IGNITION_ON":      false,
    "SPEED":            0,
    "BEARING":          0,
    "SATELLITES":       0,
    "IS_GPS_RUNNING":   false,
    "IS_LOGICALLY_BLOCKED": false,
    "IS_WAITING_BLOCK": false,
    "EVENT_TYPE":       "POSITION",
    "SERIAL_CODE":      "",
    "PACKAGE":          "<hex bruto — ignorar>",
    "ADDRESS_ROAD":     "Rua Xavante",
    "ADDRESS_NUMBER":   "",
    "ADDRESS_DISTRICT": "",
    "ADDRESS_SUBURB":   "Argentina",
    "ADDRESS_CITY":     "Criciúma",
    "ADDRESS_STATE":    "Santa Catarina",
    "ADDRESS_COUNTRY":  "Brasil",
    "ADDRESS_POSTCODE": "88813-600"
  }
}
```

**União de chaves de `packet` observada (1031 docs, gateway, nossa company):**

```
ADDRESS_CITY, ADDRESS_COUNTRY, ADDRESS_DISTRICT, ADDRESS_NUMBER, ADDRESS_POSTCODE,
ADDRESS_ROAD, ADDRESS_STATE, ADDRESS_SUBURB, BEARING, DID, EVENT_TYPE, GPS_TIME,
IGNITION_ON, IS_GPS_RUNNING, IS_LOGICALLY_BLOCKED, IS_WAITING_BLOCK, LATITUDE,
LONGITUDE, PACKAGE, SATELLITES, SERIAL_CODE, SERVER_TIME, SPEED, VEHICLE_VOLTAGE
```

> Pelo gateway com filtro de empresa, **100% dos docs vieram com `packet`** — não precisamos do tratamento "sem packet" que estava na v1 deste relatório (mas o código vai ficar defensivo mesmo assim).

---

## 3. Tabela de mapeamento — DO Telematics → formato padronizado do app

Espelhando exatamente o objeto que `server/index.js` já produz para a Getrak (linhas 49–60):

| campo do app          | Getrak (origem em `v` do snapshot)        | DO Telematics (origem em `doc` do array)                                          | observações                                              |
|-----------------------|-------------------------------------------|-----------------------------------------------------------------------------------|----------------------------------------------------------|
| `id`                  | `stripIdPrefix(v.modulo)`                 | `String(doc.did)`                                                                  | IMEI sem prefixo. Cast para string. |
| `modulo`              | `v.modulo`                                | `String(doc.did)`                                                                  | DO não tem prefixo "ID". |
| `placa`               | `v.placa`                                 | `doc.vehicle?.plate \|\| null`                                                     | Pode vir string vazia → tratar como `null`. |
| `apelido`             | `v.apelido`                               | `doc.vehicle?.name \|\| doc.name \|\| null`                                        | |
| `idVeiculo`           | `v.id_veiculo`                            | `doc.vehicle?._id \|\| null`                                                        | ObjectId. |
| `ultimaAtualizacao`   | `parseTimestamp(v.datastatus) ?? v.data`  | `doc.packet?.GPS_TIME ?? doc.packet?.SERVER_TIME ?? null`                          | Já vem em ISO 8601 UTC; só `new Date().toISOString()` para normalizar. |
| `localizacao`         | `reverseGeocode(lat, lon)`                | `reverseGeocode(LATITUDE, LONGITUDE)`                                              | Mesma função `server/geocode.js`. Fallback opcional: se Nominatim retornar `null`, montar string a partir de `ADDRESS_*` (já vem do DO). |
| `voltagem`            | `v.tensao_bateria` (V)                    | `doc.packet?.VEHICLE_VOLTAGE != null ? doc.packet.VEHICLE_VOLTAGE / 1000 : null`   | DO entrega em mV; converto para V para casar com Getrak. |
| `lat`                 | `Number(v.lat)`                           | `doc.packet?.LATITUDE ?? null`                                                     | |
| `lon`                 | `Number(v.lon)`                           | `doc.packet?.LONGITUDE ?? null`                                                    | |
| `statusOnline`        | `v.status_online`                         | derivado de `SERVER_TIME`: `(Date.now() - SERVER_TIME) < 15 min ⇒ "ONLINE"` senão `"OFFLINE"` | Heurística a confirmar. |
| **`fonte`** *(novo)*  | `"Getrak"`                                | `"DO Telematics"`                                                                  | Selo discreto no card. Vai virar campo do `Result` em `src/App.tsx`. |

### Semântica de busca

Idêntica ao `searchVehicles` do Getrak:

```text
digits = só os dígitos de query

se digits (IMEI completo OU últimos dígitos):
    match se String(doc.did).includes(digits)
senão (texto livre — placa):
    match se doc.vehicle?.plate?.toLowerCase().includes(query.toLowerCase())
```

### Dedup entre as duas fontes

Critério: mesmo IMEI normalizado nas duas fontes ⇒ mantém o de `ultimaAtualizacao` mais recente. Chave = só os dígitos:

- Getrak: `stripIdPrefix(v.modulo).replace(/\D/g, '')`
- DO: `String(doc.did)`

Em um empate de timestamps (improvável), arbitrariamente mantém a Getrak (fonte primária).

---

## 4. Dúvidas / Riscos atualizados

1. ~~Heurística de `statusOnline`~~ — proposta `(now - SERVER_TIME) < 15 min ⇒ ONLINE`. **Confirma o limiar antes de eu implementar?**
2. ~~TTL do snapshot~~ — proponho **5 min**, igual Getrak. Snapshot agora é só 1031 trackers (~600 KB JSON) — leve.
3. ~~Voltagem em mV vs V~~ — vou normalizar tudo para V (`/1000`). OK?
4. **Filtro por empresa** — vou usar `?companies=<companyId>` com o `companyId` do `/user/me` cacheado uma única vez. Isso restringe o snapshot à AGUIASAT (1031 vs 5336). **Confirma que é o comportamento desejado?** Alternativa: trazer todos os 5336 (inclui empresas-clientes/revenda).
5. **Token & refresh** — cache em memória, refresh proativo perto do `exp` do JWT, fallback de re-login no 401. Sem novas dependências (parsing manual do JWT com `Buffer.from(parts[1], 'base64url')`).
6. ~~Filtros server-side ignorados~~ — confirmado de novo: `search`/`searchKey`/`limit` não filtram nem no gateway. Snapshot local é o caminho.
7. ~~`Bearer` vs token cru~~ — no gateway o `Bearer` é definitivo.
8. **Trackers sem `packet`** — na nossa empresa, 0/1031. O código fica defensivo (`?.`) mas, na prática, não vai aparecer.
9. **Dedup por placa** — não vou dedupar por placa (só por IMEI, como pedido). Se quiser dedup adicional por placa, me avise.
10. **Concorrência do reverse geocoding** — vou trocar o `Promise.all(matches.slice(0,50).map(...))` por uma pool limitada (proposta: 3 concorrentes). Nominatim público pede ≤1 req/s, mas o cache amortiza bem para resultados repetidos.
11. **Where the apikey lives** — adiciono `DOTELEMATICS_APIKEY=` ao `.env.example` (placeholder). Você precisa adicionar a linha `DOTELEMATICS_APIKEY=<valor>` no seu `.env` real antes de rodar a Fase 2. Vou ler com `process.env.DOTELEMATICS_APIKEY`; nunca logar.

---

## 5. Ações pendentes da Fase 1

✅ Spec OpenAPI inicial localizado (api.dotelematics.com/api/swagger-ui-init.js).  
✅ Fluxo real do gateway descoberto via doc enviado pelo cliente.  
✅ Login confirmado por chamada real (200, `{ data: { access_token, refresh_token } }`).  
✅ `/user/me` validado — `companyId._id` extraído.  
✅ `/auth/refresh` validado — rotação confirmada.  
✅ `/tracking/realtime/v2?companies=<id>` validado — 1031 docs, 100% com `packet`.  
✅ Shape real coletado, campos da `packet` re-inventariados.  
✅ Mapeamento DO → app refinado.  

**Parado aqui aguardando o "pode implementar".** Pontos a confirmar antes da Fase 2: itens **1, 2, 3, 4, 10** da seção 4 (os outros já estão fechados pela investigação).
