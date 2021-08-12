// express webserver https://www.npmjs.com/package/express
// & HTTP body parsing middleware https://www.npmjs.com/package/body-parser
const express = require('express')
const bodyParser = require('body-parser')

// the official Node.js Cloudant library - https://www.npmjs.com/package/@ibm-cloud/cloudant
const { CloudantV1 } = require('@ibm-cloud/cloudant')
const client = CloudantV1.newInstance()
const DBNAME = process.env.DBNAME


// constants
const PORT = 8080 // the default for Code Engine
const HOST = '0.0.0.0' // listen on all network interfaces

//redis
const redis = require('redis')
const fs = require('fs');
const url = process.env.REDIS_URL
const cert = fs.readFileSync('redis.cert', { 'encoding': 'ascii' })

const redisClient = redis.createClient(url, { tls: { ca: cert } })

// redis does not support Promises yet. So using promisify to help there
const { promisify } = require("util");
const redisGet = promisify(redisClient.get).bind(redisClient);
const redisSet = promisify(redisClient.setex).bind(redisClient);
const redisFlush = promisify(redisClient.flushall).bind(redisClient);


const DESIGN_DOC = 'teamCounter'

// the express app with:
// - static middleware serving out the 'public' directory as a static website
// - the HTTP body parsing middleware to handling POSTed HTTP bodies
const app = express()
app.use(express.static('public'))
app.use(bodyParser.json())

// utility function to create a design document to count the frequency of each fruit type
const createDesignDoc = async function () {
  // for more information on Cloudant design documents see https://cloud.ibm.com/docs/Cloudant?topic=Cloudant-views-mapreduce
  // first see if the ddoc already exists

  try {
    // if the design document exists
    await client.getDesignDocument({
      db: DBNAME,
      ddoc: DESIGN_DOC
    })

    // nothing to do, it already exists
    console.log('design document exists')
  } catch (e) {
    // does not exist, so create it
    console.log('Creating design document')
    const designDoc = {
      views: {
        test: {
          // count occurrences within the index
          reduce: '_count',
          // simple map function to create an index on the 'team' attribute
          map: 'function (doc) {\n  emit(doc.team, null);\n}'
        }
      }
    }
    await client.putDesignDocument({
      db: DBNAME,
      designDocument: designDoc,
      ddoc: DESIGN_DOC
    })

    //now load the test data in bulk
    console.log("Uploading test data... ")
    const bulkDocs = fs.readFileSync("directorydata.json", { encoding: "utf8" })

    await client.postBulkDocs({
      db: DBNAME,
      bulkDocs: bulkDocs
    })
  }
}
createDesignDoc()

app.post('/flush', async (req, res) => {
  await redisFlush()
  console.log("cache is flushed!")
  res.send({ok:true})
}),


// respond to POST requests to the /team endpoint
app.post('/team', async (req, res) => {
  // extract the chosen team from the POSted body
  const team = req.body.team
  console.log(team)
  console.log(req.body)
  let retval
  let cache=false

  //first check the cache
  retval = await redisGet(team)
  if (retval) {
    console.log("Got from cache")
    retval = JSON.parse(retval)
    cache = true
  }
  else {
    //  retrieve from Cloudant using a MapReduce view
    console.log("fetching from Cloudant")
    retval = await client.postView({
      db: DBNAME,
      ddoc: DESIGN_DOC,
      view: 'test',
      key: team,
      include_docs: true,
      limit: 50,
      reduce: false
    })
    //save to the cache
    await redisSet(team, 15, JSON.stringify(retval))
  }
  res.send({ data: retval,
             cache: cache})
})

// start the webserver
app.listen(PORT, HOST)
console.log(`Running on http://${HOST}:${PORT}`)
