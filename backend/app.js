//Module imports
var http = require('http');
var express = require("express");
var dispatcher = require('httpdispatcher');
var formidable = require('formidable');
var path = require('path');
var pg = require('pg');
var util = require('util');
var fs = require('fs');
var promise = require('bluebird');
var pgp = require('pg-promise')(
  {promiseLib: promise}
);
var request = require('request');
var parser = require('xml2js').parseString;
//var fileupload = require('fileupload').createFileUpload('/uploadDir').middleware

session_email = 'sfarley2@wisc.edu'

var app = express()
app.use(express.static(__dirname + '/public'));
var bodyParser = require('body-parser');

function createConnection(){
  var cn = {
      host: 'localhost',
      port: 5432,
      database: 'cartlab',
      user: 'cartlabuser',
      password: 'R0b1ns0n!'
  };

  var db = pgp(cn);
  console.log("Connected.")
  return db
}

// configure app to use bodyParser()
// this will let us get the data from a POST
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

//need to do this to allow cors
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});



var router = express.Router();

hostname = 'localhost'
username = 'cartLabUser'
password = 'R0b1ns0n!'
db = 'cartlab'

//Serve on this port
const PORT=8080;

app.post('/upload', function(req, res){
  //create new database object for using in this transaction
  db = createConnection()
  console.log("Connected")
  // create an incoming form object
  var form = new formidable.IncomingForm();
  // specify that we want to allow the user to upload multiple files in a single request
  form.multiples = true;
  // store all uploads in the /uploads directory
  form.uploadDir = path.join(__dirname, '/public/uploads');
  // store and name the file
  form.on('file', function(field, file) {
    fs.rename(file.path, path.join(form.uploadDir, file.name));
  });
  form.on('field', function(name, value){
    //put the file metadata into the database
    if (name == 'metadata'){
      metadata = JSON.parse(value)
      //create the resource first
      resourceName = metadata['resourceName']
      resourceID = metadata['resourceID']
      resourceDate = metadata['creationDate']
      resourceCategory = metadata['resourceCategory']
      resourceDescription = metadata['resourceDescription']
      notes = metadata['notes']
      resourceFilename = "/uploads/" + metadata['resourceFilename']
      resourceFileType = metadata['resourceMimeType']
      resourceSize = metadata['resourceSize']
      authors = metadata['authors']
      tags = metadata.tags
      references = metadata['references']
      uploaderName = metadata['uploader']['name']
      uploaderEmail = metadata['uploader']['email']
      console.log(metadata)
      vals = [resourceID, resourceName, resourceDate, resourceCategory.toLowerCase(), resourceDescription, notes, true, null, resourceFilename,  resourceFileType, resourceSize, uploaderName, uploaderEmail]
      //get the category for this

                                          //databaseID/resourceID/resourceName/resourceDate/category/                     description/notes/embargo/auth/path/type/size/name/email/modified
      db.one("INSERT INTO Resources Values(default, $1, $2, $3, (select categoryid from categories where lower(categorytext) = $4), $5, $6, $7, $8, $9, (select mediaTypeID from MediaTypes where lower(mimetype) = $10), $11, $12, $13, FALSE, default) returning resourceid;", vals)
      .then(function(data){
          //now add authorships
          var rowid = data['resourceid']
          console.log("Inserted resource.  ID is " + rowid)
          sql = ""
          vals = []
          for (var i=0; i<authors.length; i++){
            j = i * 4 + 1
            sql += "INSERT INTO Authorship VALUES (default, $" + j + ",$" + (j + 1) + ",$" + (j + 2) + ",$" + (j + 3) + ", default); "
            vals.push(rowid, authors[i]['first'], authors[i]['last'], authors[i]['middle'])
          }
          db.none(sql, vals)
            .then(function(){
              console.log("Inserted authors, now doing tags...")
              //now add the tags
              sql = ""
              vals = []
              console.log(tags)
              if ((tags.length == 0) || (tags[0] == "") || (tags == [ '' ]) ){
                //skip this part
                console.log("tags")
                insertReference(db, references, resourceID);
              }else{
                  for (var i=0; i<tags.length; i++){
                      j = i * 2 + 1
                      tagValue = tags[i].replace(/ /g,''); //remove extra whitespace
                      sql += "INSERT INTO tags VALUES (default, $" + j + ", $" + (j + 1) + ", default); "
                      vals.push(rowid, tagValue)
                  }
                  console.log(sql)
                  db.none(sql, vals)
                    .then(function(){
                      console.log("Inserted tags, now doing reference.")
                      console.log("Success!")
                      insertReference(db, references, resourceID)
                    })
                    .catch(function(err){
                      console.log("Error entering tag information.")
                      console.log(err)
                    })
              }
            })
            .catch(function(){
              console.log("Error entering authorship information.")
            })
        })
        .catch(function(err){
          console.log(err)
        })
    }
  })
  // log any file upload errors that occur
  form.on('error', function(err) {
    console.log('An error has occured: \n' + err);
  });
  form.on('end', function(fields) {
    //produce response for client
    res.json({success: true, data: []})
  });
  // parse the incoming request containing the form data
  form.parse(req, function(err, fields, files){

  });

});

function insertReference(db, references, resourceID){
  //get the deconstructed reference from FreeCite
  console.log("Doing reference.")
  console.log(references)
  for (var i =0; i< references.length; i++){
    reference = references[i]
    if ((reference != "") && (reference  != null)){
      getCitation(reference, resourceID, db)
    }else{
      console.log("No reference")
    }
  }

}

function getCitation(referencetxt, resourceID, db){
  request.post('http://freecite.library.brown.edu/citations/create', {
		headers: {
			accept: "text/xml"
		},
		form: {
			citation: referencetxt
		}},function (err, response, body) {
      parser(body, function(err, json){
        citations = json['citations']
        theCitation = citations['citation'][0]
        isValid = theCitation['$']['valid']
        if ((isValid) || (isValid == 'true')){
          insertCitation(theCitation, resourceID, db)
        }else{
          console.log("Error fetching or parsing citation from freeCite")
        }
      })
		});
}

function insertCitation(citation, resourceID, db){
  console.log(citation)
  authors = citation['authors'][0]['author']
  //format the authors for bibtex
  authorString = ""
  for (var j =0; j < authors.length; j++){
    thisAuthor = authors[j]
    console.log(thisAuthor)
    authorString += thisAuthor + " and "
  }
  authorString = authorString.slice(0, -5);
  try{
    title = citation['title'][0]
  }catch(err){
    title = null
  }
  try{
    journal = citation['journal'][0]
  }catch(err){
    journal = null
  }
  try{
    volume = citation['volume'][0]
  }catch(err){
    volume = null
  }
  try{
    number = citation['number'][0]
  }catch(err){
    number = null
  }
  try{
    pages = citation['pages'][0]
  }
  catch(err){
    pages = null
  }
  try{
    year = +citation['year'][0]
  }catch(err){
    year = null
  }
  raw = citation['raw_string'][0]
  try{
    publisher = citation['publisher'][0]
  }catch(err){
    publisher = null
  }
  place = null
  typeOfReference = null
  doi = null
  db.none("INSERT INTO objectreferences values(default, $1, $2, $3, $4, $5, $6, $7,$8, $9, $10, $11, $12, $13 )", [resourceID, authorString,
        title, journal, place, volume, number, pages, year, publisher, doi, typeOfReference, raw])
        .then(function(){
          console.log("Inserted reference")
        })
        .catch(function(err){
          console.log(err)
        })
}

app.get("/search", function(req, res){

})

app.get("/mediaTypes", function(req, res){
  db = createConnection()
  db.any("SELECT mimetype, description FROM mediatypes where allowed = TRUE")
  .then(function(data){
    res.status(200).json({success: true, data:data});
  })
  .catch(function(err){
    res.status(500).json({success: false, error: err})
  })
})

app.get("/categories", function(req, res){
  db = createConnection()
  db.any("SELECT categorytext FROM categories;")
    .then(function(data){
      res.status(200).json({success: true, data:data});
    })
    .catch(function(err){
      res.status(500).json({success: false, error: err})
    })
})

app.get("/unauthorizedResource", function(req, res){
  db = createConnection();
  //first choose the resource
  sql = "SELECT * From Resources "
  sql += " INNER JOIN Categories on Resources.ResourceCategory = Categories.CategoryID  "
  sql += " INNER JOIN MediaTypes on Resources.ObjectType = MediaTypes.MediaTypeID "
  sql += "  WHERE EmbargoStatus = TRUE AND Rejected = FALSE "
  sql += " ORDER BY resourceID DESC LIMIT 1;"
  console.log(sql)
  db.oneOrNone(sql)
    .then(function(resourceData){
      //get the ResourceID
      response = resourceData
      if (response  == null){
        res.status(200).json({success: true, data: []})
      }else{
        resourceID = resourceData['resourceid']
        //now get the associated tags
        sql = "SELECT tagid, tagtext FROM Tags WHERE ResourceID = $1;"
        db.any(sql, [resourceID])
          .then(function(tags){
            //make a nice list instead of the object
            tagList = []
            for (var i= 0; i< tags.length; i ++){
              tagList.push(tags[i]['tagtext'])
            }
            response['tags'] = tagList
            //now get the authors
            //same resourceID
            sql = "SELECT authorshipid, authorfirst, authormiddle, authorlast FROM Authorship where ResourceID = $1;"
            db.any(sql, [resourceID])
              .then(function(authors){
                response['authors'] = authors
                //finally, get the references, and then return
                sql = "SELECT referenceid, rawRef from objectreferences where resourceID = $1;"
                db.any(sql, [resourceID])
                  .then(function(references){
                    response['references'] = references
                    res.status(200).json({success: true, data:response})
                  }).catch(function(err){
                    //catch errors from reference call
                    res.status(500).json({success:false, error:err, location: "References"})
                  })
              }).catch(function(err){
                //catch errors from authors call
                res.status(500).json({success: false, error: err, location: "Authors"})
              })
          })
          .catch(function(err){
            //catch errors from tags call
            res.status(500).json({success: false, error: err, location: "Tags"})
          })
      }
    })
    .catch(function(err){
      //catch errors from resources call
      res.status(500).json({success: false, error: err, location: "Resources"})
    })
})


app.get("/approve/:id", function(req, res){
  //approve this resource and release the EmbargoStatus
  //attach the authorization to an authorized user
  thisResource = req.params.id
  db = createConnection()
  sql = "UPDATE Resources SET EmbargoStatus=FALSE, embargoauth=(SELECT UserID from authusers where lower(useremail)=lower($1)), modified=current_timestamp WHERE resourceid=$2;"
  values = [session_email, thisResource]
  console.log(values)
  db.none(sql, values)
    .then(function(){
      //insert into the authorized users action table, so we can keep track of rejections and approvals
      sql = "INSERT INTO AuthActions VALUES (DEFAULT, $1, (SELECT UserID from authusers where lower(useremail)=lower($2)), TRUE, default);"
      db.none(sql, values)
        .then(function(){
          res.json({success: true, data:[]})
        })
        .catch(function(err){
          res.json({success: false, error: err, location: "AuthActions"})
        })
    })
    .catch(function(err){
      res.json({success:false, error: err, location:"Embargo release"})
    })
})

app.get("/reject/:id", function(req, res){
  //reject an upload
  thisResource = req.params.id
  db = createConnection()
  sql = "UPDATE Resources SET Rejected=TRUE, modified=current_timestamp WHERE resourceid=$1;"
  values = [thisResource]
  db.none(sql, values)
    .then(function(){
      //insert into the authorized users action table, so we can keep track of rejections and approvals
      sql = "INSERT INTO AuthActions VALUES (DEFAULT, $1, (SELECT UserID from authusers where lower(useremail)=lower($2)), FALSE, default);"
      db.none(sql, [thisResource, session_email])
        .then(function(){
          res.json({success: true, data:[]})
        })
        .catch(function(err){
          res.json({success: false, error: err, location: "AuthActions"})
        })
    })
    .catch(function(err){
      res.json({success:false, error: err, location:"Rejection"})
    })
})


app.get("/", function(req, res){
  db = createConnection();
  console.log("DB Connection working.")
})

app.listen(PORT);
