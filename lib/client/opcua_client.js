"use strict";
/**
 * @module opcua.client
 */
require("requirish")._(module);

var util = require("util");
var _ = require("underscore");
var assert = require("better-assert");
var crypto = require("crypto");
var async = require("async");

var OPCUAClientBase = require("lib/client/client_base").OPCUAClientBase;

var StatusCodes = require("lib/datamodel/opcua_status_code").StatusCodes;

var session_service = require("lib/services/session_service");
var AnonymousIdentityToken = session_service.AnonymousIdentityToken;
var CreateSessionRequest = session_service.CreateSessionRequest;
var CreateSessionResponse = session_service.CreateSessionResponse;
var ActivateSessionRequest = session_service.ActivateSessionRequest;
var ActivateSessionResponse = session_service.ActivateSessionResponse;
var CloseSessionRequest = session_service.CloseSessionRequest;

var endpoints_service = require("lib/services/get_endpoints_service");
var ApplicationDescription = endpoints_service.ApplicationDescription;
var ApplicationType = endpoints_service.ApplicationType;
var EndpointDescription = endpoints_service.EndpointDescription;
var MessageSecurityMode = endpoints_service.MessageSecurityMode;

var securityPolicy_m = require("lib/misc/security_policy");
var SecurityPolicy = securityPolicy_m.SecurityPolicy;


var crypto_utils = require("lib/misc/crypto_utils");
var UserNameIdentityToken = session_service.UserNameIdentityToken;


var s = require("lib/datamodel/structures");
var UserIdentityTokenType = s.UserIdentityTokenType;

var ClientSession = require("lib/client/client_session").ClientSession;

var utils =  require("lib/misc/utils");
var debugLog = utils.make_debugLog(__filename);
var doDebug = utils.checkDebugFlag(__filename);


function validateServerNonce(serverNonce) {
    return (serverNonce && serverNonce.length < 32) ? false : true;
}

/**
 * @class OPCUAClient
 * @extends OPCUAClientBase
 * @param options
 * @param [options.securityMode=MessageSecurityMode.None] {MessageSecurityMode} the default security mode.
 * @param [options.securityPolicy =SecurityPolicy.NONE] {SecurityPolicy} the security mode.
 * @param [options.requestedSessionTimeout= 20000]            {Number} the requested session time out in CreateSession
 * @param [options.applicationName="NodeOPCUA-Client"]        {string} the client application name
 * @param [options.endpoint_must_exist=true] {Boolean} set to false if the client should accept server endpoint mismatch
 * @param [options.keepSessionAlive=false]{Boolean}
 * @param [options.certificateFile="certificates/client_selfsigned_cert_1024.pem"] {String} client certificate pem file.
 * @param [options.privateKeyFile="certificates/client_key_1024.pem"] {String} client private key pem file.
 * @constructor
 */
function OPCUAClient(options) {

    options = options || {};
    OPCUAClientBase.apply(this, arguments);

    // @property endpoint_must_exist {Boolean}
    // if set to true , create Session will only accept connection from server which endpoint_url has been reported
    // by GetEndpointsRequest.
    // By default, the client is strict.
    this.endpoint_must_exist = ( options.endpoint_must_exist === null) ? true : options.endpoint_must_exist;

    this.requestedSessionTimeout = options.requestedSessionTimeout || 20000;

    this.applicationName = options.applicationName || "NodeOPCUA-Client";

}
util.inherits(OPCUAClient, OPCUAClientBase);


OPCUAClient.prototype._nextSessionName = function () {
    if (!this.___sessionName_counter) {
        this.___sessionName_counter = 0;
    }
    this.___sessionName_counter += 1;
    return "Session" + this.___sessionName_counter;
};

var makeApplicationUrn = require("lib/misc/applicationurn").makeApplicationUrn;

OPCUAClient.prototype._getApplicationUri = function () {

    // get applicationURI from certificate
    var exploreCertificate = require("lib/misc/crypto_explore_certificate").exploreCertificate;

    var certificate = this.getCertificate();
    var applicationUri;
    if (certificate) {
        var e = exploreCertificate(certificate);
        applicationUri = e.tbsCertificate.extensions.subjectAltName.uniformResourceIdentifier[0];
    } else {
        var hostname = require("lib/misc/hostname").get_fully_qualified_domain_name();
        applicationUri = makeApplicationUrn(hostname, this.applicationName);
    }
    return applicationUri;

};


OPCUAClient.prototype.__resolveEndPoint = function () {

    this.securityPolicy = this.securityPolicy || SecurityPolicy.None;

    var endpoint = this.findEndpoint(this._secureChannel.endpoint_url, this.securityMode, this.securityPolicy);
    this.endpoint = endpoint;


    // this is explained here : see OPCUA Part 4 Version 1.02 $5.4.1 page 12:
    //   A  Client  shall verify the  HostName  specified in the  Server Certificate  is the same as the  HostName
    //   contained in the  endpointUrl  provided in the  EndpointDescription. If there is a difference  then  the
    //   Client  shall report the difference and may close the  SecureChannel.

    if (!this.endpoint) {
        if (this.endpoint_must_exist) {
            debugLog("OPCUAClient#endpoint_must_exist = true and endpoint with url " ,this._secureChannel.endpoint_url, " cannot be found");
            return false;
        } else {
            // fallback :
            // our strategy is to take the first server_end_point that match the secutity settings
            // ( is this really OK ?)
            // this will permit us to access a OPCUA Server using it's IP address instead of its hostname

            endpoint = this.findEndpointForSecurity(this.securityMode, this.securityPolicy);
            if (!endpoint) {
                return false;
            }
            this.endpoint = endpoint;
        }
    }
    return true;
};

OPCUAClient.prototype._createSession = function (callback) {

    assert(typeof callback === "function");
    assert(this._secureChannel);

    if (!this.__resolveEndPoint() || !this.endpoint) {
        return callback(new Error(" End point must exist " + this._secureChannel.endpoint_url));
    }
    assert(this.endpoint);

    this.serverUri = this.endpoint.server.applicationUri;

    this.endpoint_url = this._secureChannel.endpoint_url;


    var applicationUri = this._getApplicationUri();


    var applicationDescription = new ApplicationDescription({
        applicationUri: applicationUri,
        productUri: "NodeOPCUA-Client",
        applicationName: {text: this.applicationName},
        applicationType: ApplicationType.CLIENT,
        gatewayServerUri: undefined,
        discoveryProfileUri: undefined,
        discoveryUrls: [ ]
    });

    assert(this.serverUri, " must have a valid server URI");
    assert(this.endpoint_url, " must have a valid server endpoint_url");

    // note : do not confuse CreateSessionRequest.clientNonce with OpenSecureChannelRequest.clientNonce
    //        which are two different nonce, with different size (although they share the same name )
    this.clientNonce = crypto.randomBytes(32);

    var request = new CreateSessionRequest({
        clientDescription: applicationDescription,
        serverUri: this.serverUri,
        endpointUrl: this.endpoint_url,
        sessionName: this._nextSessionName(),
        clientNonce: this.clientNonce,
        clientCertificate: this.getCertificate(),
        requestedSessionTimeout: this.requestedSessionTimeout,
        maxResponseMessageSize: 800000
    });

    // a client Nonce must be provided if security mode is set
    assert(this._secureChannel.securityMode === MessageSecurityMode.NONE || request.clientNonce !== null);

    var self = this;
    self.performMessageTransaction(request, function (err, response) {

        var session = null;
        if (!err) {

            //xx console.log("xxxxx response",response.toString());
            //xx console.log("xxxxx response",response.responseHeader.serviceResult);
            if (response.responseHeader.serviceResult === StatusCodes.BadTooManySessions) {

                err = new Error("Too Many Sessions : " + response.responseHeader.serviceResult.toString());

            } else if (response.responseHeader.serviceResult === StatusCodes.Good) {

                assert(response instanceof CreateSessionResponse);

                // istanbul ignore next
                if (!validateServerNonce(request.serverNonce)) {
                    return callback(new Error("invalid server Nonce"));
                }

                // todo: verify SignedSoftwareCertificates and  response.serverSignature

                session = new ClientSession(self);
                session.name = request.sessionName;
                session.sessionId = response.sessionId;
                session.authenticationToken = response.authenticationToken;
                session.timeout = response.revisedSessionTimeout;
                session.serverNonce = response.serverNonce;
                session.serverCertificate = response.serverCertificate;
                session.serverSignature = response.serverSignature;

                debugLog("revised session timeout = ".yellow, session.timeout);

                self._server_endpoints = response.serverEndpoints;
                session.serverEndpoints = response.serverEndpoints;

            } else {
                err = new Error("??? " + response.responseHeader.serviceResult);
            }
        }
        callback(err, session);

    });

};


var computeSignature = require("lib/misc/security_policy").computeSignature;
OPCUAClient.prototype.computeClientSignature = function (channel, serverCertificate, serverNonce) {
    var self = this;
    return computeSignature(serverCertificate, serverNonce, self.getPrivateKey(), channel.messageBuilder.securityPolicy);
};

function isAnonymous(userIdentityInfo) {
    return !userIdentityInfo || (!userIdentityInfo.userName && !userIdentityInfo.password);
}

function isUserNamePassword(userIdentityInfo) {
    var res = (userIdentityInfo.userName !== undefined) && (userIdentityInfo.password !== undefined);
    return res;
}

function findUserTokenPolicy(endpoint_description, userTokenType) {
    assert(endpoint_description instanceof EndpointDescription);
    var r = _.filter(endpoint_description.userIdentityTokens, function (userIdentity) {
        // assert(userIdentity instanceof UserTokenPolicy)
        assert(userIdentity.tokenType);
        return userIdentity.tokenType === userTokenType;
    });
    return r.length === 0 ? null : r[0];
}

function createAnonymousIdentityToken(session) {

    var endpoint_desc = session.endpoint;
    assert(endpoint_desc instanceof EndpointDescription);

    var userTokenPolicy = findUserTokenPolicy(endpoint_desc, UserIdentityTokenType.ANONYMOUS);
    if (!userTokenPolicy) {
        throw new Error("Cannot find ANONYMOUS user token policy in end point description");
    }
    return new AnonymousIdentityToken({policyId: userTokenPolicy.policyId});
}

function createUserNameIdentityToken(session, userName, password) {

    // assert(endpoint instanceof EndpointDescription);
    assert(userName === null || typeof userName === "string");
    assert(password === null || typeof password === "string");
    var endpoint_desc = session.endpoint;
    assert(endpoint_desc instanceof EndpointDescription);

    var userTokenPolicy = findUserTokenPolicy(endpoint_desc, UserIdentityTokenType.USERNAME);

    // istanbul ignore next
    if (!userTokenPolicy) {
        throw new Error("Cannot find USERNAME user token policy in end point description");
    }

    var securityPolicy = securityPolicy_m.fromURI(userTokenPolicy.securityPolicyUri);

    // if the security policy is not specified we use the session security policy
    if (securityPolicy === SecurityPolicy.Invalid) {
        securityPolicy = session._client._secureChannel.securityPolicy;
        assert(securityPolicy);
    }

    var serverCertificate = session.serverCertificate;
    assert(serverCertificate instanceof Buffer);

    serverCertificate = crypto_utils.toPem(serverCertificate, "CERTIFICATE");
    var publicKey = crypto_utils.extractPublicKeyFromCertificateSync(serverCertificate);

    var serverNonce = session.serverNonce;
    assert(serverNonce instanceof Buffer);


    // see Release 1.02 155 OPC Unified Architecture, Part 4
    var cryptoFactory = securityPolicy_m.getCryptoFactory(securityPolicy);

    // istanbul ignore next
    if (!cryptoFactory) {
        throw new Error(" Unsupported security Policy");
    }

    var userIdentityToken = new UserNameIdentityToken({
        userName: userName,
        password: new Buffer(password, "utf-8"),
        encryptionAlgorithm: cryptoFactory.asymmetricEncryptionAlgorithm,
        policyId: userTokenPolicy.policyId
    });


    // now encrypt password as requested
    var lenBuf = new Buffer(4);
    lenBuf.writeUInt32LE(userIdentityToken.password.length + serverNonce.length, 0);
    var block = Buffer.concat([lenBuf, userIdentityToken.password, serverNonce]);
    userIdentityToken.password = cryptoFactory.asymmetricEncrypt(block, publicKey);

    return userIdentityToken;
}

OPCUAClient.prototype.createUserIdentityToken = function (session, userIdentityToken, callback) {
    assert(_.isFunction(callback));
    var self = this;

    if (isAnonymous(self.userIdentityInfo)) {

        try {
            userIdentityToken = createAnonymousIdentityToken(session);
            return callback(null, userIdentityToken);
        }
        catch (err) {
            return callback(err);
        }

    } else if (isUserNamePassword(self.userIdentityInfo)) {

        var userName = self.userIdentityInfo.userName;
        var password = self.userIdentityInfo.password;

        try {
            userIdentityToken = createUserNameIdentityToken(session, userName, password);
            return callback(null, userIdentityToken);
        }
        catch (err) {
            //xx console.log(err.stack);
            return callback(err);
        }
    } else {
        console.log(" userIdentityToken = ", userIdentityToken);
        return callback(new Error("CLIENT: Invalid userIdentityToken"));
    }
};


// see OPCUA Part 4 - $7.35
OPCUAClient.prototype._activateSession = function (session, callback) {

    assert(typeof callback === "function");
    var self = this;

    // istanbul ignore next
    if (!self._secureChannel) {
        callback(new Error(" No secure channel"));
    }

    var serverCertificate = session.serverCertificate;
    // If the securityPolicyUri is NONE and none of the UserTokenPolicies requires encryption,
    // the Client shall ignore the ApplicationInstanceCertificate (serverCertificate)
    assert(serverCertificate === null || serverCertificate instanceof Buffer);

    var serverNonce = session.serverNonce;
    assert(!serverNonce || serverNonce instanceof Buffer);

    // make sure session is attached to this client
    var _old_client = session._client;
    session._client = self;

    self.createUserIdentityToken(session, self.userIdentityInfo, function (err, userIdentityToken) {

        if (err) {
            session._client = _old_client;
            return callback(err);
        }

        // TODO. fill the ActivateSessionRequest
        // see 5.6.3.2 Parameters OPC Unified Architecture, Part 4 30 Release 1.02
        var request = new ActivateSessionRequest({

            // This is a signature generated with the private key associated with the
            // clientCertificate. The SignatureAlgorithm shall be the AsymmetricSignatureAlgorithm
            // specified in the SecurityPolicy for the Endpoint. The SignatureData type is defined in 7.30.

            clientSignature: self.computeClientSignature(self._secureChannel, serverCertificate, serverNonce),

            // These are the SoftwareCertificates which have been issued to the Client application. The productUri contained
            // in the SoftwareCertificates shall match the productUri in the ApplicationDescription passed by the Client in
            // the CreateSession requests. Certificates without matching productUri should be ignored.  Servers may reject
            // connections from Clients if they are not satisfied with the SoftwareCertificates provided by the Client.
            // This parameter only needs to be specified in the first ActivateSession request after CreateSession.
            // It shall always be omitted if the maxRequestMessageSize returned from the Server in the CreateSession
            // response is less than one megabyte. The SignedSoftwareCertificate type is defined in 7.31.

            clientSoftwareCertificates: [],

            // List of locale ids in priority order for localized strings. The first LocaleId in the list has the highest
            // priority. If the Server returns a localized string to the Client, the Server shall return the translation
            // with the highest priority that it can. If it does not have a translation for any of the locales identified
            // in this list, then it shall return the string value that it has and include the locale id with the string.
            // See Part 3 for more detail on locale ids. If the Client fails to specify at least one locale id, the Server
            // shall use any that it has.
            // This parameter only needs to be specified during the first call to ActivateSession during a single
            // application Session. If it is not specified the Server shall keep using the current localeIds for the Session.
            localeIds: [],

            // The credentials of the user associated with the Client application. The Server uses these credentials to
            // determine whether the Client should be allowed to activate a Session and what resources the Client has access
            // to during this Session. The UserIdentityToken is an extensible parameter type defined in 7.35.
            // The EndpointDescription specifies what UserIdentityTokens the Server shall accept.
            userIdentityToken: userIdentityToken,

            // If the Client specified a user   identity token that supports digital signatures,
            // then it shall create a signature and pass it as this parameter. Otherwise the parameter is omitted.
            // The SignatureAlgorithm depends on the identity token type.
            userTokenSignature: {
                algorithm: null,
                signature: null
            }

        });

        session.performMessageTransaction(request, function (err, response) {

            if (!err && response.responseHeader.serviceResult === StatusCodes.Good) {

                assert(response instanceof ActivateSessionResponse);

                session.serverNonce = response.serverNonce;

                if (!validateServerNonce(session.serverNonce)) {
                    return callback(new Error("Invalid server Nonce"));
                }
                callback(null, session);

            } else {

                err = err || new Error(response.responseHeader.serviceResult.toString());
                session._client = _old_client;
                callback(err, null);
            }
        });

    });

};

/**
 * transfer session to this client
 * @method reactivateSession
 * @param session
 * @param callback
 * @return {*}
 */
OPCUAClient.prototype.reactivateSession = function (session, callback) {

    var self = this;
    assert(typeof callback === "function");
    assert(this._secureChannel, " client must be connected first");

    // istanbul ignore next
    if (!this.__resolveEndPoint() || !this.endpoint) {
        return callback(new Error(" End point must exist " + this._secureChannel.endpoint_url));
    }

    assert(session._client.endpointUrl === self.endpointUrl, "cannot reactivateSession on a different endpoint");
    var old_client = session._client;

    this._activateSession(session, function (err) {
        if (!err) {

            if (old_client !== self) {
                // remove session from old client:
                old_client._removeSession(session);
                assert(!_.contains(old_client._sessions, session));

                self._addSession(session);
                assert(_.contains(self._sessions, session));
            }

        } else {
            console.log("reactivateSession has failed !".red.bgWhite, err);
        }
        callback(err);
    });
};
/**
 * create and activate a new session
 * @async
 * @method createSession
 *
 * @param [options {Object} ] optional
 *
 * @param callback {Function}
 * @param callback.err     {Error|null}   - the Error if the async method has failed
 * @param callback.session {ClientSession} - the created session object.
 *
 *
 * @example :
 *
 *
 *     // create a anonymous session
 *     client.createSession(function(err) {
 *       if (err) {} else {}
 *     });
 *
 *     // create a session with a userName and password
 *     client.createSession({userName: "JoeDoe", password:"secret"}, function(err) {
 *       if (err) {} else {}
 *     });
 *
 */
OPCUAClient.prototype.createSession = function (userIdentityInfo, callback) {

    var self = this;
    if (_.isFunction(userIdentityInfo)) {
        callback = userIdentityInfo;
        userIdentityInfo = {};
    }

    self.userIdentityInfo = userIdentityInfo;

    assert(_.isFunction(callback));

    self._createSession(function (err, session) {
        if (err) {
            callback(err);
        } else {

            self._addSession(session);

            self._activateSession(session, function (err) {
                callback(err, session);
            });
        }
    });
};

OPCUAClient.prototype.changeSessionIdentity = function(session,userIdentityInfo,callback) {

    var self = this;
    assert(_.isFunction(callback));

    var old_userIdentity = self.userIdentityInfo;
    self.userIdentityInfo = userIdentityInfo;

    self._activateSession(session, function (err) {
        callback(err);
    });


};

OPCUAClient.prototype._closeSession = function (session, deleteSubscriptions,callback) {

    assert(_.isFunction(callback));
    assert(_.isBoolean(deleteSubscriptions));

    // istanbul ignore next
    if (!this._secureChannel) {
        return callback(new Error("no channel"));
    }
    assert(this._secureChannel);

    var request = new CloseSessionRequest({
        deleteSubscriptions: deleteSubscriptions
    });

    session.performMessageTransaction(request, function (err, response) {

        if (err) {
            //xx console.log("xxx received : ", err, response);
            //xx self._secureChannel.close(function () {
            //xx     callback(err, null);
            //xx });
            callback(err, null);
        } else {
            callback(err, response);
        }
    });
};

/**
 *
 * @method closeSession
 * @async
 * @param session  {ClientSession} -
 * @param callback {Function} - the callback
 * @param callback.err {Error|null}   - the Error if the async method has failed
 */
OPCUAClient.prototype.closeSession = function (session, callback) {

    var self = this;
    assert(_.isFunction(callback));
    assert(session);
    assert(session._client === self, "session must be attached to self");

    var deleteSubscriptions = true;
    //todo : send close session on secure channel
    self._closeSession(session, deleteSubscriptions, function (err) {
        self._removeSession(session);
        callback(err);
    });
};

OPCUAClient.prototype._ask_for_subscription_republish = function(session,callback) {

    if (doDebug) { debugLog("_ask_for_subscription_republish ".bgCyan.yellow.bold);}
    session.getPublishEngine().republish(function(err) {
        callback(err);
    });
};


OPCUAClient.prototype._on_connection_reestablished = function(callback) {

    var self = this;
    assert(_.isFunction(callback));

    // call base class implementation first
    OPCUAClientBase.prototype._on_connection_reestablished.call(self,function(err){

        //
        // a new secure channel has be created, we need to reactivate the session,
        // and reestablish the subscription and restart the publish engine.
        //
        //
        // see OPC UA part 4 ( version 1.03 ) figure 34 page 106
        // 6.5 Reestablishing subscription....
        //
        //
        //
        //                      +---------------------+
        //                      | CreateSecureChannel |
        //                      | CreateSession       |
        //                      | ActivateSession     |
        //                      +---------------------+
        //                                |
        //                                |
        //                                v
        //                      +---------------------+
        //                      | CreateSubscription  |<-------------------------------------------------------------+
        //                      +---------------------+                                                              |
        //                                |                                                                         (1)
        //                                |
        //                                v
        //                      +---------------------+
        //     (2)------------->| StartPublishEngine  |
        //                      +---------------------+
        //                                |
        //                                V
        //                      +---------------------+
        //             +------->| Monitor Connection  |
        //             |        +---------------------+
        //             |                    |
        //             |                    v
        //             |          Good    /   \
        //             +-----------------/ SR? \______Broken_____+
        //                               \     /                 |
        //                                \   /                  |
        //                                                       |
        //                                                       v
        //                                                 +---------------------+
        //                                                 |                     |
        //                                                 | CreateSecureChannel |<-----+
        //                                                 |                     |      |
        //                                                 +---------------------+      |
        //                                                         |                    |
        //                                                         v                    |
        //                                                       /   \                  |
        //                                                      / SR? \______Bad________+
        //                                                      \     /
        //                                                       \   /
        //                                                         |
        //                                                         |Good
        //                                                         v
        //                                                 +---------------------+
        //                                                 |                     |
        //                                                 | ActivateSession     |
        //                                                 |                     |
        //                                                 +---------------------+
        //                                                         |
        //                                                         v                    +-------------------+       +----------------------+
        //                                                       /   \                  | CreateSession     |       |                      |
        //                                                      / SR? \______Bad_______>| ActivateSession   |-----> | TransferSubscription |
        //                                                      \     /                 |                   |       |                      |       (1)
        //                                                       \   /                  +-------------------+       +----------------------+        ^
        //                                                         | Good                                                      |                    |
        //                                                         v   (for each subscription)                                   |                    |
        //                                                 +--------------------+                                            /   \                  |
        //                                                 |                    |                                     OK    / OK? \______Bad________+
        //                                                 | RePublish          |<----------------------------------------- \     /
        //                                             +-->|                    |                                            \   /
        //                                             |   +--------------------+
        //                                             |           |
        //                                             |           v
        //                                             | GOOD    /   \
        //                                             +------  / SR? \______Bad SubscriptionInvalidId______>(1)
        // (2)                                                  \     /
        //  ^                                                    \   /
        //  |                                                      |
        //  |                                                      |
        //  |                             BadMessageNotAvailable   |
        //  +------------------------------------------------------+
        //



        debugLog(" Starting Session reactivation".red.bgWhite);
        // repair session
        var sessions = self._sessions;
        async.map(sessions, function (session, next) {

            debugLog("OPCUAClient#_on_connection_reestablished TRYING TO REACTIVATE SESSION");
            self._activateSession(session,function(err){
                //
                // Note: current limitation :
                //  - The reconnection doesn't work if connection break is cause by a server that crashes and restarts yet.
                //
                // todo :
                //   if failed => recreate a new Channel and transfer the subscription
                //   else
                //      call Republish
                //
                debugLog("ActivateSession : ",err ? err.message : "");
                console.log("err = ",err);
                if (!err)  {
                    return self._ask_for_subscription_republish(session,next);
                }
                next(err);
            });

        },function(err,results) {
            var err = err;
            return callback(err);
        });

    });

};


exports.OPCUAClient = OPCUAClient;
exports.ClientSession = ClientSession;

