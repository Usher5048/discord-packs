/**
 * @name SelfJS
 * @description Breaking Discord's TOS to bot user accounts.
 * @author Эмберс
 * @version 4.0.0
 */

const version = "4.0.0";
const https = require("https");
const ws = require("ws");
const fs = require("fs");

const OPCODES = {
    IDENTIFY: 2,
    HEARTBEAT: 1,
    RESUME: 6,

    HELLO: 10,
    HEARTBEAT_ACK: 11,
    RECONNECT: 7,
    DISPATCH: 0,
    INVALID_SESSION: 9
};

// Unicode JSON
function unison(data) {
    const str = JSON.stringify(data);
    if(!str) return "";

    // An actual atrocity 
    return str.replace(
        /[\u007F-\uFFFF]/g,
        c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4)
    ); 
}

function rawRequest(options={}) {
    const path     = options.path    ?? "";
    const method   = options.method  ?? "GET";
    const headers  = options.headers ?? {};
    const host     = options.host    ?? "discord.com";
    const port     = options.port    ?? 443;
    const fullPath = !options.host   ? `/api/v10${path}` : options.path;
    const body     = !options.host ? unison(options.body) : options.body;

    if(body) {
        headers["Content-Length"] = Buffer.byteLength(body);
        if(!headers["Content-Type"])
            headers["Content-Type"] = "application/json";
    }

    const reqOpt = {
        host,
        port,
        path: fullPath,
        method,
        headers
    };
    
    return new Promise(function(resolve) {
        const req = https.request(reqOpt, function(res) {
            const chunks = [];

            res
                .on("data", c => chunks.push(c))
                .on("end", function() {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks)));
                    } catch(e) {
                        resolve(Buffer.concat(chunks));
                    }
                });
        });

        req.write(body);
        req.end();
    });
}

const POST   = (options={}) => rawRequest({...options, method: "POST"  });
const GET    = (options={}) => rawRequest({...options, method: "GET"   });
const PATCH  = (options={}) => rawRequest({...options, method: "PATCH" });
const PUT    = (options={}) => rawRequest({...options, method: "PUT"   });
const DELETE = (options={}) => rawRequest({...options, method: "DELETE"});

function buildFormData(options) {
    const boundary = Date.now().toString(16).padStart(16, '-');
    let form = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="payload_json"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${unison(options.json)}\r\n`
    );

    for(let i = 0; i < options.paths?.length; i++) {
        const attach = options.json.attachments[i];
        const filename = attach.filename;
        const data = fs.existsSync(options.paths[i]) ?
            fs.readFileSync(options.paths[i]) :
            "";

        form = Buffer.concat([
            form,
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="files[${i}]"; filename="${filename}"\r\n` +
                `Content-Type: ${attach.content_type ?? "application/octet-stream"}\r\n\r\n`
            ),
            data,
            Buffer.from("\r\n")
        ]);
    }

    const body = Buffer.concat([
        form,
        Buffer.from(`--${boundary}--`)
    ]);

    return {
        body: body.toString(),
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`
        }
    };
}

class Webhook {
    constructor(options={}) {
        this.id    = options.id    ?? null;
        this.token = options.token ?? null;

        this.pathExt = `/webhooks/${this.id}/${this.token}`;
    }

    validate() {
        if(!this.id || !this.token)
            throw new Error("Invalid webhook ID or token");
    }

    sendMessage(data) {
        this.validate();
        return POST({
            path: this.pathExt,
            ...buildFormData({
                json: data,
                paths: data.files
            })
        });
    }

    editMessage(id, data) {
        this.validate();
        return PATCH({
            path: `${this.pathExt}/messages/${id}`,
            ...buildFormData({
                json: data,
                paths: data.files
            })
        });
    }

    deleteMessage(id) {
        this.validate();
        return DELETE({
            path: `${this.pathExt}/messages/${id}`
        });
    }
}

// Not so safe piece of code
async function retrieveToken(options={}) {
    const response = await POST({
        path: "/auth/login",
        body: options
    });

    if(!Object.keys(response).includes("mfa"))
        return {success: false, ...response};
    
    if(!response.mfa)
        return {success: true, requiresMFA: false, token: response.token};

    return {
        success: true,
        requiresMFA: true,
        protocols: Object.entries(response)
            .filter(([key, val]) =>
                key != "mfa" && val === true
            ).map(([key, _]) => key),
        
        step: function(options={}) {
            const protocol = options.protocol ?? "backup";

            // Piss off discord!
            // if(protocol == "sms" && !options.code) {
            //     return POST({
            //         path: "/auth/mfa/sms/send",
            //         body: {ticket: response.ticket}
            //     });
            // }

            if(protocol == "sms")
                throw new Error("SMS protocol not supported!");

            return POST({
                path: `/auth/mfa/${protocol}`,
                body: {
                    code: options.code,
                    ticket: response.ticket
                }
            });
        }
    }
}

async function validateToken(token) {
    return new Promise(function(resolve) {
        const sock = new ws("wss://gateway.discord.gg?v=10&encoding=json");

        sock.once("open", function() {
            sock.send(unison({
                op: OPCODES.IDENTIFY,
                d: {
                    token,
                    properties: {
                        os: "SelfJS",
                        browser: "SelfJS",
                        device: "SelfJS"
                    }
                }
            }));
        }.bind(this));

        sock.on("error", () => resolve({success: false, valid: false}));
        sock.on("close", () => resolve({success: true,  valid: false}));
        sock.on("message", function(payload) {
            const packet = JSON.parse(payload);
            if(packet.op != 0 || packet.t != "READY") return;

            sock.close();
            resolve({
                success: true,
                valid: true,
                user: packet.d.user
            });
        });
    });
}

class Client {
    #createLogFile = true;
    #debugLogs     = false;
    #isMobile      = false;

    #socket = null;
    #sequence = -1;
    #heartbeatInterval = null;
    #startTime = Date.now();
    #listeners = [];
    #sessionID = null;
    #resumeURL = null;
    #lastHB = -1;
    #receivedLastHB = true;
    #heartbeatTimeout = 10000;
    #reconnectDelay = 5000;

    #POST   = null;
    #GET    = null;
    #PATCH  = null;
    #PUT    = null;
    #DELETE = null;

    constructor(options={}) {
        this.user = {};
        this.token = null;
        this.latency = -1;
        this.loggedIn = false;
        
        this.#createLogFile    = options.createLogFile    ?? true; 
        this.#debugLogs        = options.debugLogs        ?? false;
        this.#isMobile         = options.isMobile         ?? false;
        this.#heartbeatTimeout = options.heartbeatTimeout ?? 10000;
        this.#reconnectDelay   = options.reconnectDelay   ?? 5000;
        
        if(this.#createLogFile) {
            fs.writeFileSync("latest.log", "");

            fs.appendFileSync("latest.log", `SelfJS v${version}\n`);
            fs.appendFileSync("latest.log", `Timestamp: ${this.#startTime}\n\n`);
        }
    }

    removeAllListeners() {this.#listeners = [];}
    removeListener(evt, callback=null) {
        for(let i = this.#listeners.length - 1; i >= 0; i--) {
            if(this.#listeners[i].event != evt) continue;
            if(callback && this.#listeners[i].callback != callback) continue;

            this.#listeners.splice(i, 1);
        }
    }

    once(evt, callback) {
        this.#listeners.push({
            persistent: false,
            event: evt,
            callback,
        });
    }

    on(evt, callback) {
        this.#listeners.push({
            persistent: true,
            event: evt,
            callback,
        });
    }

    #log(...args) {
        if(this.#debugLogs)
            console.log(`(SelfJS v${version})`, ...args);
        
        if(this.#createLogFile) {
            fs.appendFileSync("latest.log", `(${Date.now() - this.#startTime}ms) `);
            fs.appendFileSync("latest.log", args.join(" ") + "\n");
        }
    }

    #handleHeartbeat() {
        this.#socket.send(unison({
            op: OPCODES.HEARTBEAT,
            d: this.#sequence
        }));

        this.#lastHB = Date.now();
        this.#log("[Gateway] Sent HEARTBEAT");

        setTimeout(function() {
            if(!this.#receivedLastHB) {
                this.#log("[Gateway] HEARTBEAT ACK failed, reconnecting");
                this.reconnect();
            }
            
            this.#receivedLastHB = false;
        }.bind(this), this.#heartbeatTimeout);
    }

    reconnect() {
        clearInterval(this.#heartbeatInterval);
        this.#socket.terminate();

        this.#socket = new ws(this.#resumeURL);
        
        this.#socket.once("open", function() {  
            this.#socket.send(unison({
                op: OPCODES.RESUME,
                d: {
                    token: this.token,
                    session_id: this.#sessionID,
                    seq: this.#sequence
                }
            }));

            this.#log("[Gateway] Sent RESUME");
        }.bind(this));

        this.#socket.once("error", function(err) {
            // this.#log(`[stderr] ${err}`);
            
            this.#socket.terminate();
            this.#log("[Gateway] RESUME failed");

            this.#fireListeners("invalidated", null);

            // setTimeout(
            //     this.reconnect.bind(this),
            //     this.#reconnectDelay
            // );
        }.bind(this));

        this.#socket.on("message", this.#handlePacket.bind(this));

        return new Promise(function(resolve) {
            this.once("READY", function() {
                resolve();
            }.bind(this));
        }.bind(this));
    }

    #fireListeners(event, ...args) {
        for(const listener of this.#listeners) {
            if(listener.event == '*') {

                listener.callback(event, ...args);
                if(!listener.persistent)
                    this.removeListener('*', listener.callback);

                continue;
            }

            if(listener.event != event) continue;

            listener.callback(...args);
            if(!listener.persistent)
                this.removeListener(event, listener.callback);
        }
    }

    #handlePacket(payload) {
        const packet = JSON.parse(payload);

        switch(packet.op) {
            case OPCODES.HELLO: {
                this.#log("[Gateway] Received HELLO");
                this.#handleHeartbeat();

                clearInterval(this.#heartbeatInterval);
                this.#heartbeatInterval = setInterval(
                    this.#handleHeartbeat.bind(this),
                    packet.d.heartbeat_interval
                );

                break;
            }

            case OPCODES.HEARTBEAT_ACK: {
                this.#log("[Gateway] Received HEARTBEAT_ACK");

                this.latency = Date.now() - this.#lastHB;
                this.#receivedLastHB = true;

                break;
            }

            case OPCODES.INVALID_SESSION: {
                this.#log("[Gateway] Received INVALID_SESSION");
                this.#fireListeners("invalidated", packet.d);

                clearInterval(this.#heartbeatInterval);
                this.disconnect();

                break;
            }

            case OPCODES.RECONNECT: {
                this.#log("[Gateway] Received RECONNECT");
                this.reconnect();
                break;
            }

            case OPCODES.DISPATCH: {
                this.#sequence = packet.s;

                if(packet.t == "READY") {
                    this.user = packet.d.user;
                    this.#sessionID = packet.d.session_id;
                    this.#resumeURL = packet.d.resume_gateway_url;

                    this.#log("[Gateway] Received READY");
                    this.loggedIn = true;
                }

                let shouldAck = true;
                if(packet.t == "MESSAGE_CREATE")
                    packet.d.preventAck = () => shouldAck = false;

                this.#fireListeners(packet.t, packet.d);

                if(packet.t != "MESSAGE_CREATE") break;
                if(!shouldAck) break;

                this.acknowledgeMessage(packet.d);

                break;
            }

            default: {
                this.#log(`[Gateway] Received unknown opcode: ${packet.op}`);
                break;
            }
        }
    }

    login(token) {
        this.token = token;

        this.#POST   = (o={}) => POST  ({...o, headers: {...o.headers, Authorization: token}});
        this.#GET    = (o={}) => GET   ({...o, headers: {...o.headers, Authorization: token}});
        this.#PATCH  = (o={}) => PATCH ({...o, headers: {...o.headers, Authorization: token}});
        this.#PUT    = (o={}) => PUT   ({...o, headers: {...o.headers, Authorization: token}});
        this.#DELETE = (o={}) => DELETE({...o, headers: {...o.headers, Authorization: token}});

        this.#socket = new ws("wss://gateway.discord.gg?v=10&encoding=json");
        this.#socket.once("open", function() {
            this.#socket.send(unison({
                op: OPCODES.IDENTIFY,
                d: {
                    token,
                    properties: {
                        os: this.#isMobile ? "android" : "SelfJS",
                        browser: "SelfJS",
                        device: "SelfJS"
                    }
                }
            }));

            this.#log("[Gateway] Sent IDENTIFY");
        }.bind(this));

        this.#socket.once("error", function(err) {
            // this.#log(`[stderr] ${err}`);
            
            this.#socket.terminate();
            this.#log("[Gateway] IDENTIFY failed");

            setTimeout(
                (() => this.login(this.token)).bind(this),
                this.#reconnectDelay
            );
        }.bind(this));

        this.#socket.on("message", this.#handlePacket.bind(this));

        return new Promise(function(resolve) {
            this.once("READY", function() {
                resolve();
            }.bind(this));
        }.bind(this));
    }

    disconnect() {
        if(this.#socket) this.#socket.close();
        this.removeAllListeners();
        this.loggedIn = false;

        this.#log("[Gateway] Closed connection");
    }

    logout() {
        if(this.#socket) this.#socket.close();
        this.removeAllListeners();
        this.loggedIn = false;

        this.#log("[Gateway] Closed connection");
        return this.#POST({path: "/auth/logout"});
    }


    // kinda misleading, uploads the file(s) to discords servers
    // but doesnt send them in a message, instead returns info
    // about the file(s) for use in sendMessage
    async uploadAndGetInfo(options) {
        const shouldUpload = options.uploadFiles ?? true;
        const attachmentRequest = await this.#POST({
            path: `/channels/${options.channel_id}/attachments`,
            body: {
                files: options.files.map(function(e, i) {
                    return {
                        filename: e.filename,
                        file_size: e.file_size,
                        is_clip: e.is_clip ?? false,
                        id: i.toString()
                    };
                })
            }
        });

        if(!attachmentRequest.attachments)
            return null;

        if(!shouldUpload)
            return attachmentRequest.attachments;

        for(const file of attachmentRequest.attachments) {
            const fileObj = options.files.find(e => e.filename == file.upload_filename.split('/').pop());
            const host = file.upload_url.split("://")[1].split('/')[0];
            const path = file.upload_url.split(host)[1];

            // how did we get here?
            if(!fileObj)
                throw new Error(`File object mismatch! Couldn't find '${file.upload_filename.split('/').pop()}' in file list.`);

            await PUT({
                host,
                path,
                headers: {"Content-Type": "application/octet-stream"},
                body: fileObj.data
            });
        }

        return attachmentRequest.attachments;
    }

    sendMessage(msg) {
        return this.#POST({
            path: `/channels/${msg.channel_id}/messages`,
            body: msg
        });
    }

    editMessage(msg) {
        return this.#PATCH({
            path: `/channels/${msg.channel_id}/messages/${msg.id}`,
            body: msg
        });
    }

    deleteMessage(msg) {
        return this.#DELETE({
            path: `/channels/${msg.channel_id}/messages/${msg.id}`
        });
    }
    
    acknowledgeMessage(msg) {
        return this.#POST({
            path: `/channels/${msg.channel_id}/messages/${msg.id}/ack`,
            body: {token: null}
        });
    }

    getChannels() {
        return this.#GET({
            path: "/users/@me/channels"
        });
    }

    getGuilds() {
        return this.#GET({
            path: "/users/@me/guilds"
        });
    }

    getMessages(options={}) {
        const before = options.before ? `before=${options.before}` : "";
        const limit = `limit=${options.limit ?? 50}`;
        const query = `${limit}&${before}`;

        return this.#GET({
            path: `/channels/${options.channel_id}/messages?${query}`
        });
    }

    getUserInfo(userID) {
        return this.#GET({
            path: `/users/${userID}`
        });
    }

    getChannelInfo(channelID) {
        return this.#GET({
            path: `/channels/${channelID}`
        });
    }

    findChannel(recipients) {
        return this.#POST({
            path: `/users/@me/channels`,
            body: {recipients}
        });
    }
}

module.exports = {
    version,
    Client,
    Webhook,
    rawRequest,
    retrieveToken,
    validateToken
};