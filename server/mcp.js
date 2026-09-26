// Minimal Model Context Protocol server over Streamable HTTP (stateless JSON responses).
// Lets Claude or any MCP client read and edit the logbook with WANDER_API_TOKEN.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const flightFields = {
  date: { type: "string", description: "Departure date, YYYY-MM-DD (local)." },
  from: { type: "string", description: "Departure airport, 3-letter IATA code, e.g. BOM." },
  to: { type: "string", description: "Arrival airport, 3-letter IATA code, e.g. DEL." },
  flight: { type: "string", description: "Airline IATA code plus number, e.g. 6E2114." },
  time: { type: "string", description: "Local departure time HH:MM." },
  duration: { type: "string", description: "Block time h:mm. Estimated from distance if omitted." },
  aircraft: { type: "string", description: "IATA aircraft type code, e.g. 32N, 77W." },
  registration: { type: "string" },
  seat: { type: "string", description: "e.g. 14A" },
  seatType: { type: "string", enum: ["window", "middle", "aisle"] },
  cabin: { type: "string", enum: ["economy", "premium", "business", "first"] },
  reason: { type: "string", enum: ["leisure", "business", "crew", "other"] },
  trip: { type: "string" },
  note: { type: "string", description: "Free text, e.g. booking reference." },
};

export const TOOLS = [
  { name: "list_flights", description: "Search the flight log. Newest first. Status is flown, upcoming or cancelled (booked but not flown).",
    inputSchema: { type: "object", properties: {
      year: { type: "string" }, airport: { type: "string", description: "IATA code; matches departure or arrival." }, from: { type: "string" }, to: { type: "string" },
      airline: { type: "string", description: "IATA airline code, e.g. 6E" }, status: { type: "string", enum: ["flown", "upcoming", "cancelled"] },
      q: { type: "string", description: "Free-text search" }, limit: { type: "number", description: "Default 50, max 500" } } },
    annotations: { readOnlyHint: true } },
  { name: "add_flight", description: "Add one flight to the log. Future dates are stored as upcoming. Distance is computed from the airports.",
    inputSchema: { type: "object", properties: flightFields, required: ["date", "from", "to"] } },
  { name: "add_flights", description: "Add several flights at once, e.g. every leg of a booking.",
    inputSchema: { type: "object", properties: { flights: { type: "array", items: { type: "object", properties: flightFields, required: ["date", "from", "to"] } } }, required: ["flights"] } },
  { name: "update_flight", description: "Change fields on an existing flight (seat, aircraft, note, time, duration, cabin, reason, trip, registration).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...flightFields }, required: ["id"] } },
  { name: "mark_not_flown", description: "Mark a flight as booked but not flown (cancelled, rebooked, missed). It stays in the log but leaves all statistics.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "restore_flight", description: "Undo mark_not_flown.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_flight", description: "Permanently delete a flight entered by mistake. Prefer mark_not_flown for flights that were booked but not taken.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true } },
  { name: "get_stats", description: "Lifetime or single-year statistics: flights, km, time in air, airports, countries, airlines, top routes, flights per year.",
    inputSchema: { type: "object", properties: { year: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "review_queue", description: "Flights that were probably not flown: codeshares logged twice, duplicates, rebookings, itineraries that don't connect.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "lookup_flight", description: "Look up schedule, aircraft and status for a flight number on a date (needs AERODATABOX_API_KEY on the server).",
    inputSchema: { type: "object", properties: { flight: { type: "string" }, date: { type: "string" } }, required: ["flight", "date"] }, annotations: { readOnlyHint: true } },
];

const WRITE_TOOLS = new Set(["add_flight", "add_flights", "update_flight", "mark_not_flown", "restore_flight", "delete_flight"]);

export async function handleMcp(message, { service, canWrite }) {
  const reply = result => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, msg) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: msg } });
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request");
  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wander", title: "Wander flight logbook", version: "1.0.0" },
        instructions: "A personal flight logbook. Airports and airlines use IATA codes. Use mark_not_flown, not delete_flight, for flights that were booked but not taken. Check review_queue for likely data errors.",
      });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = message.params || {};
      if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      if (WRITE_TOOLS.has(name) && !canWrite) return reply(text("This token can read the logbook but not change it.", true));
      try { return reply(text(JSON.stringify(await callTool(name, args, service), null, 1))); }
      catch (e) { return reply(text(e.message || "The tool failed.", true)); }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, a, service) {
  switch (name) {
    case "list_flights": return service.query(a).map(slim);
    case "add_flight": return slim(service.create(a, "agent"));
    case "add_flights": {
      const out = { added: [], failed: [] };
      for (const [i, f] of (a.flights || []).entries()) {
        try { out.added.push(slim(service.create(f, "agent"))); } catch (e) { out.failed.push({ index: i, error: e.message }); }
      }
      return out;
    }
    case "update_flight": {
      const { id, ...fields } = a;
      const cur = service.all().find(f => f.id === id);
      if (!cur) throw new Error("No flight with that id.");
      return slim(service.replace(id, { ...cur, ...fields }));
    }
    case "mark_not_flown": return slim(service.patch(a.id, { status: "cancelled" }));
    case "restore_flight": return slim(service.patch(a.id, { status: "flown" }));
    case "delete_flight": return service.remove(a.id);
    case "get_stats": return service.stats(a.year);
    case "review_queue": return service.reviewQueue();
    case "lookup_flight": return service.lookup(a.flight, a.date);
  }
}

function slim(f) {
  const { id, date, time, from, to, flight, distanceKm, duration, aircraft, seat, seatType, cabin, reason, status, note, trip } = f;
  return Object.fromEntries(Object.entries({ id, date, time, from, to, flight, distanceKm, duration, aircraft, seat, seatType, cabin, reason, status, note, trip }).filter(([, v]) => v !== "" && v !== undefined));
}
