const express = require("express");
const path = require("path");
const https = require("https");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");

require("dotenv").config();

const app = express();
const portNumber = 7003;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.resolve(__dirname, "templates"));

const mongoUri = process.env.MONGO_CONNECTION_STRING;

const MovieSchema = new mongoose.Schema(
  {
    imdbId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    year: { type: String, default: "" },
    synopsis: { type: String, default: "" },
    rating: { type: String, default: "N/A" },
  },
  { versionKey: false }
);

const Movie = mongoose.model("Movie", MovieSchema);

const RAPIDAPI_HOST = "imdb236.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

function rapidApiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "GET",
        hostname: RAPIDAPI_HOST,
        port: null,
        path: apiPath,
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!(res.statusCode >= 200 && res.statusCode < 300)) {
            return reject(new Error(`API ${res.statusCode}: ${raw}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Non-JSON response: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function imdbAutocomplete(query) {
  const q = encodeURIComponent(query.trim());
  const data = await rapidApiGet(`/api/imdb/autocomplete?query=${q}`);

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.d)) return data.d;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.titles)) return data.titles;
  if (Array.isArray(data?.items)) return data.items;

  return [];
}

function getTitle(r) {
  return (r.primaryTitle || r.title || r.l || r.name || r.originalTitle || "").toString();
}

function getImdbId(r) {
  return r.imdbId || r.id || r.tconst || r.const || r?.i || null;
}

function pickBest(results, query) {
  const q = query.trim().toLowerCase();
  let best = null;
  let bestScore = -1;

  for (const r of results) {
    const title = getTitle(r).toLowerCase();
    const id = getImdbId(r);

    if (!title) continue;
    if (id && !String(id).startsWith("tt")) continue;

    let score = 0;
    if (title === q) score = 3;
    else if (title.startsWith(q)) score = 2;
    else if (title.includes(q)) score = 1;
    else continue;

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
}

async function imdbGetDetails(id) {
  return await rapidApiGet(`/api/imdb/${encodeURIComponent(id)}`);
}

function extractSynopsis(d) {
  return (
    d?.description ||
    d?.plot ||
    d?.plotSummary ||
    d?.storyline ||
    d?.plotOutline?.text ||
    d?.plot?.plotText?.plainText ||
    d?.plot?.plotText?.text ||
    "No synopsis available."
  );
}

function extractRating(d) {
  return (
    d?.averageRating ??
    d?.rating ??
    d?.ratingsSummary?.aggregateRating ??
    d?.ratingsSummary?.rating ??
    d?.aggregateRating ??
    "N/A"
  );
}

function extractYear(d, fallback) {
  return (
    d?.startYear ??
    d?.year ??
    d?.releaseYear ??
    fallback?.startYear ??
    fallback?.year ??
    fallback?.y ??
    ""
  ).toString();
}

app.get("/", (req, res) => {
  res.render("index", { movie: null, error: null });
});

app.post("/search", async (req, res) => {
  try {
    const query = (req.body.title || "").trim();
    if (!query) return res.render("index", { movie: null, error: "Please enter a movie title." });

    const results = await imdbAutocomplete(query);
    const best = pickBest(results, query);
    if (!best) return res.render("index", { movie: null, error: "No matching movie found." });

    const imdbId = getImdbId(best);
    if (!imdbId) return res.render("index", { movie: null, error: "No IMDb ID found." });

    const details = await imdbGetDetails(imdbId);

    const movieDoc = {
      imdbId,
      title: details?.primaryTitle || getTitle(best) || query,
      year: extractYear(details, best),
      synopsis: extractSynopsis(details),
      rating: String(extractRating(details)),
    };

    await Movie.updateOne({ imdbId }, { $set: movieDoc }, { upsert: true });

    res.render("index", { movie: movieDoc, error: null });
  } catch (e) {
    console.error(e);
    res.render("index", { movie: null, error: "Search failed." });
  }
});

app.get("/movies", async (req, res) => {
  try {
    const movies = await Movie.find({}).lean();
    res.render("movies", { movies });
  } catch (e) {
    console.error(e);
    res.status(500).send("Error loading movies.");
  }
});

app.post("/clear", async (req, res) => {
  try {
    await Movie.collection.drop();
    res.render("cleared", { deletedCount: "all" });
  } catch (e) {
    if (e && (e.code === 26 || e.message?.includes("ns not found"))) {
      return res.render("cleared", { deletedCount: 0 });
    }
    console.error(e);
    res.status(500).send("Error clearing movies.");
  }
});

mongoose
  .connect(mongoUri)
  .then(() => {
    app.listen(portNumber);
    console.log(`main URL http://localhost:${portNumber}/`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
