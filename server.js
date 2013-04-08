// vim: ts=4:sw=4
//-----------------------------------------------------------------------------
// Droppy - File server in node.js
// https://github.com/silverwind/Droppy
//-----------------------------------------------------------------------------
// TODOs:
// - Test cases with special characters in filenames in both Windows and Linux
// - Add ability to navigate to subfolders
// - Multiple file operations like delete/move
// - Media queries (if needed)
// - Authentication
// - gzip compression
// - Check for any XSS
//-----------------------------------------------------------------------------

var fileList     = {},
    resDir       = "./res/",
    readInterval = 200,
    server       = null,
    last         = null,
    cache        = {},
    fs           = require("fs"),
    formidable   = require("formidable"),
    io           = require("socket.io"),
    mime         = require("mime"),
    util         = require("util"),
    config       = require("./config.json");

"use strict";

// Read and cache the HTML and strip whitespace
var HTML = fs.readFileSync(resDir + "html.html", {"encoding": "utf8"});
cache.HTML = HTML.replace(/(\n)/gm,"").replace(/(\t)/gm,"");

//-----------------------------------------------------------------------------
// Set up the directory for files and start the server
fs.mkdir(config.filesDir, function (err) {
    if ( !err || err.code === "EEXIST") {
        if(!config.useSSL) {
            server = require("http").createServer(onRequest);
        } else {
            var key, cert;
            try {
                key = fs.readFileSync(config.httpsKey);
                cert = fs.readFileSync(config.httpsCert);
            } catch(error) {
                logIt("Error reading required SSL certificate or key.");
                handleError(error);
            }
            server = require("https").createServer({key: key, cert: cert}, onRequest);
        }
        server.listen(config.port);
        server.on("listening", function() {
            log("Listening on " + server.address().address + ":" + config.port);
            io = io.listen(server, {"log level": 1});
            createWatcher();
            prepareFileList();
            setupSockets();
        });
        server.on("error", function (err) {
            if (err.code === "EADDRINUSE")
                log("Failed to bind to config.port " + config.port + ".");
            else
                handleError(err);
        });
    } else {
        handleError(err);
    }

});
//-----------------------------------------------------------------------------
// Watch the directory for realtime changes and send them to the client.
function createWatcher() {
    fs.watch(config.filesDir,{ persistent: true }, function(event,filename){
        if(event == "change" || event == "rename") {
            prepareFileList(function(){
                SendUpdate();
            });
        }
    });
}
//-----------------------------------------------------------------------------
// Send file list JSON over websocket
function SendUpdate() {
    io.sockets.emit("UPDATE_FILES", JSON.stringify(fileList));
}
//-----------------------------------------------------------------------------
// Websocket listener
function setupSockets() {
    io.sockets.on("connection", function (socket) {
        socket.on("REQUEST_UPDATE", function () {
            SendUpdate();
        });
        socket.on("CREATE_FOLDER", function (name) {
            fs.mkdir(config.filesDir + name, null, function(err){
                if(err) handleError(err);
            });
        });
    });
}
//-----------------------------------------------------------------------------
// GET/POST handler
function onRequest(req, res) {
    var method = req.method.toUpperCase();
    var socket = req.socket.remoteAddress + ":" + req.socket.remotePort;

    log("REQ:  " + socket + "\t" + method + "\t" + req.url);
    if (method == "GET") {
        if (req.url.match(/^\/res\//))
            handleResourceRequest(req,res,socket);
        else if (req.url.match(/^\/files\//))
            handleFileRequest(req,res,socket);
        else if (req.url.match(/^\/delete\//))
            handleDeleteRequest(req,res,socket);
        else if (req.url == "/") {
            res.writeHead(200, {
                "content-type"  : "text/html",
                "Cache-Control" : "max-age=3600, public"
            });
            res.end(cache.HTML);
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (method === "POST" && req.url === "/upload") {
        handleUploadRequest(req,res,socket);
    }
}
//-----------------------------------------------------------------------------
// Serve resources. Everything from /res/ will be cached by both the server and client
function handleResourceRequest(req,res,socket) {
    var resourceName = unescape(req.url.substring(resDir.length -1));
    if (cache[resourceName] === undefined){
        var path = resDir + resourceName;
        fs.readFile(path, function (err, data) {
            if(!err) {
                cache[resourceName] = {};
                cache[resourceName].data = data;
                cache[resourceName].size = fs.statSync(unescape(path)).size;
                cache[resourceName].mime = mime.lookup(unescape(path));
                serve();
            } else {
                handleError(err);
                res.writeHead(404);
                res.end();
                return;
            }
        });
    } else {
        serve();
    }

    function serve() {
        log("SEND: " + socket + "\t\t" + resourceName + " (" + convertToSI(cache[resourceName].size) + ")");

        res.writeHead(200, {
            "Content-Type"      : cache[resourceName].mime,
            "Content-Length"    : cache[resourceName].size,
            "Cache-Control"     : "max-age=3600, public"
        });
        res.end(cache[resourceName].data);
    }
}
//-----------------------------------------------------------------------------
function handleFileRequest(req,res,socket) {
    var path = config.filesDir + unescape(req.url.substring(config.filesDir.length -1));
    if (path) {
        var mimeType = mime.lookup(path);

        fs.stat(path, function(err,stats){
            if(err) {
                res.writeHead(500);
                res.end();
                handleError(err);
                SendUpdate(); // Send an update so the client's data stays in sync
            }
            log("SEND: " + socket + "\t\t" + path + " (" + convertToSI(stats.size) + ")");
            res.writeHead(200, {
                "Content-Type"      : mimeType,
                "Content-Length"    : stats.size
            });
            fs.createReadStream(path, {"bufferSize": 4096}).pipe(res);
        });
    }
}
//-----------------------------------------------------------------------------
function handleDeleteRequest(req,res,socket) {
    fs.readdir(config.filesDir, function(err, files){
        if(!err) {
            var path = config.filesDir + unescape(req.url.replace(/^\/delete\//,""));
            log("DEL:  " + path);
            try {
                var stats = fs.statSync(path);
                if (stats.isFile()) {
                    fs.unlink(path);
                } else if (stats.isDirectory()){
                    fs.rmdir(path);
                }
                res.writeHead(200, {
                    "Content-Type" : "text/html"
                });
                res.end();
            } catch(error) {
                res.writeHead(500);
                res.end();
                handleError(error);
                SendUpdate(); // Send an update so the client's data stays in sync
            }
        } else {
            res.writeHead(500);
            res.end();
            handleError(err);
            SendUpdate(); // Send an update so the client's data stays in sync
        }
    });
}
//-----------------------------------------------------------------------------
function handleUploadRequest(req,res,socket) {
    if (req.url == "/upload" ) {
        var form = new formidable.IncomingForm();
        form.uploadDir = config.filesDir;
        form.parse(req);
        form.on("fileBegin", function(name, file) {
            log("RECV: " + socket + "\t\t" + file.name );
            file.path = form.uploadDir + "/" + file.name;
        });
        form.on('end', function() {
            SendUpdate();
        });

        form.on("error", function(err) {
            handleError(err);
            SendUpdate(); // Send an update so the client's data stays in sync
        });

        res.writeHead(200, {
            "Content-Type" : "text/html"
        });
        res.end();
    }
}
//-----------------------------------------------------------------------------
// Read the directory's content and store it in the fileList object
function prepareFileList(callback){
    function run(){
        last = new Date();
        fileList = {};
        fs.readdir(config.filesDir, function(err,files) {
            if(err) handleError(err);
            for(i=0,len=files.length;i<len;i++){
                var name = files[i], type;
                try{
                    var stats = fs.statSync(config.filesDir + name);
                    if (stats.isFile())
                        type = "f";
                    if (stats.isDirectory())
                        type = "d";
                    if (type == "f" || type == "d") {
                        fileList[i] = {"name": name, "type": type, "size" : stats.size};
                    }
                } catch(error) {
                    handleError(error);
                }
            }
            if(callback !== undefined) callback();
        });
    }
    debounce(run(),readInterval);
}
//-----------------------------------------------------------------------------
// Logging and error handling helpers
function log(msg) {
    console.log(getTimestamp() + msg);
}

function handleError(err) {
    if (typeof err === "object") {
        if (err.message)
            log(err.message);
        if (err.stack)
            log(err.stack);
    }
}

process.on("uncaughtException", function (err) {
    log("=============== Uncaught exception! ===============");
    handleError(err);
});
//-----------------------------------------------------------------------------
// Helper function for log timestamps
function getTimestamp() {
    var currentDate = new Date();
    var day = currentDate.getDate();
    var month = currentDate.getMonth() + 1;
    var year = currentDate.getFullYear();
    var hours = currentDate.getHours();
    var minutes = currentDate.getMinutes();
    var seconds = currentDate.getSeconds();

    if (hours < 10) hours = "0" + hours;
    if (minutes < 10) minutes = "0" + minutes;
    if (seconds < 10) seconds = "0" + seconds;

    return month + "/" + day + "/" + year + " "+ hours + ":" + minutes + ":" + seconds + " ";
}
//-----------------------------------------------------------------------------
// Helper function for size values
function convertToSI(bytes) {
    var kib = 1024;
    var mib = kib * 1024;
    var gib = mib * 1024;
    var tib = gib * 1024;

    if ((bytes >= 0) && (bytes < kib)) {
        return bytes + ' B';
    } else if ((bytes >= kib) && (bytes < mib)) {
        return (bytes / kib).toFixed(2) + ' KiB';
    } else if ((bytes >= mib) && (bytes < gib)) {
        return (bytes / mib).toFixed(2) + ' MiB';
    } else if ((bytes >= gib) && (bytes < tib)) {
        return (bytes / gib).toFixed(2) + ' GiB';
    } else if (bytes >= tib) {
        return (bytes / tib).toFixed(2) + ' TiB';
    } else {
        return bytes + ' B';
    }
}
//-----------------------------------------------------------------------------
// underscore's debounce
// https://github.com/documentcloud/underscore
function debounce(func, wait, immediate) {
    var timeout, result;
    return function() {
        var context = this, args = arguments;
        var later = function() {
            timeout = null;
            if (!immediate) result = func.apply(context, args);
        };
        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) result = func.apply(context, args);
        return result;
    };
}