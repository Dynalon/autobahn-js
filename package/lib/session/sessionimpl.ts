///////////////////////////////////////////////////////////////////////////////
//
//  AutobahnJS - http://autobahn.ws, http://wamp.ws
//
//  A JavaScript library for WAMP ("The Web Application Messaging Protocol").
//
//  Copyright (C) 2011-2014 Tavendo GmbH, http://tavendo.com
//
//  Licensed under the MIT License.
//  http://www.opensource.org/licenses/mit-license.php
//
///////////////////////////////////////////////////////////////////////////////

// require('assert') would be nice .. but it does not
// work with Google Closure after Browserify

var when = require('when');
var when_fn = require("when/function");
import {Promise, Deferred} from 'when';

var log = require('../log.js');
var util = require('../util.js');

// IE fallback (http://afuchs.tumblr.com/post/23550124774/date-now-in-ie8)
Date.now = Date.now || function() { return +new Date; };

import Event from "./event";
import Error from "./error";
import Invocation from "./invocation";
import Result from "./result";
import Publication from "./publication";
import Subscription from "./subscription";
import Registration from "./registration";
import WAMP_FEATURES from "./wamp_features";

interface NumberedHashtable<T> {
    [id: number]: T;
}

/**
 * Tuple type representing the list of SUbSCRIBE requests that are pending.
 */
type SubscribeRequest = [
    // deferred that resolves the the SUBSCRIBED ack from the broker arrived
    Deferred<Subscription>,
    // topic
    string,
    // handler
    Function,
    // options
    Object
];

// generate a WAMP ID
//
function newid() {
    return Math.floor(Math.random() * 9007199254740992);
}


var MSG_TYPE = {
    HELLO: 1,
    WELCOME: 2,
    ABORT: 3,
    CHALLENGE: 4,
    AUTHENTICATE: 5,
    GOODBYE: 6,
    HEARTBEAT: 7,
    ERROR: 8,
    PUBLISH: 16,
    PUBLISHED: 17,
    SUBSCRIBE: 32,
    SUBSCRIBED: 33,
    UNSUBSCRIBE: 34,
    UNSUBSCRIBED: 35,
    EVENT: 36,
    CALL: 48,
    CANCEL: 49,
    RESULT: 50,
    REGISTER: 64,
    REGISTERED: 65,
    UNREGISTER: 66,
    UNREGISTERED: 67,
    INVOCATION: 68,
    INTERRUPT: 69,
    YIELD: 70
};

class Session {

    public onjoin: Function;
    public onleave: Function;

    // the transport connection (WebSocket object)
    private _socket;

    // the Deferred factory to use
    // TODO don't use union type, don't use undefined object returns at all
    private _defer: () => Promise<any> & Deferred<any>;

    // the WAMP authentication challenge handler
    private _onchallenge: Function;

    // the WAMP session ID
    private _id = null;

    // the WAMP realm joined
    private _realm = null;

    // the WAMP features in use
    private _features = null;

    // closing state
    private _goodbye_sent = false;
    private _transport_is_closing = false;

    // outstanding requests;
    private _publish_reqs = {};

    private _subscribe_reqs: NumberedHashtable<SubscribeRequest> = {};

    private _unsubscribe_reqs = {};
    private _call_reqs = {};
    private _register_reqs = {};
    private _unregister_reqs = {};

    // subscriptions in place;
    private _subscriptions: NumberedHashtable<Array<Subscription>> = {};

    // registrations in place;
    private _registrations = {};

    // incoming invocations;
    private _invocations = {};

    // prefix shortcuts for URIs
    private _prefixes = {};

    // the defaults for 'disclose_me'
    private _caller_disclose_me = false;
    private _publisher_disclose_me = false;

    private _MESSAGE_MAP = {};

    private _process_SUBSCRIBE_ERROR: Function;
    private _process_UNSUBSCRIBED: Function;
    private _process_UNSUBSCRIBE_ERROR: Function;
    private _process_PUBLISHED: Function;
    private _process_PUBLISH_ERROR: Function;
    private _process_EVENT: Function;
    private _process_REGISTERED: Function;
    private _process_REGISTER_ERROR: Function;
    private _process_UNREGISTERED: Function;
    private _process_RESULT: Function;
    private _process_UNREGISTER_ERROR: Function;
    private _process_CALL_ERROR: Function;
    private _process_INVOCATION: Function;

    // only used for performance measurement
    private _created;

    public get defer() {
        return this._defer;
    }

    public get id() {
        return this._id;
    }

    public get realm() {
        return this._realm;
    }

    public get isOpen() {
        return this.id !== null;
    }

    public get features() {
        return this._features;
    }

    public get caller_disclose_me() {
        return this._caller_disclose_me;
    }

    public set caller_disclose_me(newValue) {
        this._caller_disclose_me = newValue;
    }

    public get publisher_disclose_me() {
        return this._publisher_disclose_me;
    }

    public set publisher_disclose_me(newValue) {
        this._publisher_disclose_me = newValue;
    }

    public get subscriptions() {
        var keys = Object.keys(this._subscriptions);
        var vals = [];
        for (var i = 0; i < keys.length; ++i) {
            vals.push(this._subscriptions[keys[i]]);
        }
        return vals;
    }

    public get registrations() {
        var keys = Object.keys(this._registrations);
        var vals = [];
        for (var i = 0; i < keys.length; ++i) {
            vals.push(this._registrations[keys[i]]);
        }
        return vals;
    }

    constructor(socket, defer, onchallenge: Function) {

        var self = this;

        this._socket = socket;
        this._defer = defer;
        this._onchallenge = onchallenge;

        this._id = null;

        self._MESSAGE_MAP[MSG_TYPE.ERROR] = {};
        self._MESSAGE_MAP[MSG_TYPE.SUBSCRIBED] = self._process_SUBSCRIBED;


        self._process_SUBSCRIBE_ERROR = function(msg) {
            //
            // process ERROR reply to SUBSCRIBE
            //
            var request = msg[2];
            if (request in self._subscribe_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._subscribe_reqs[request];

                var d = r[0];

                d.reject(error);

                delete self._subscribe_reqs[request];

            } else {
                self._protocol_violation("SUBSCRIBE-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.SUBSCRIBE] = self._process_SUBSCRIBE_ERROR;


        self._process_UNSUBSCRIBED = function(msg) {
            //
            // process UNSUBSCRIBED reply to UNSUBSCRIBE
            //
            var request = msg[1];

            if (request in self._unsubscribe_reqs) {

                var r = self._unsubscribe_reqs[request];

                var d = r[0];
                var subscription = r[1];

                if (subscription.id in self._subscriptions) {
                    var subs = self._subscriptions[subscription.id];
                    // the following should actually be NOP, since UNSUBSCRIBE was
                    // only sent when subs got empty
                    for (var i = 0; i < subs.length; ++i) {
                        subs[i].active = false;
                        subs[i]._on_unsubscribe.resolve();
                    }
                    delete self._subscriptions[subscription];
                }

                d.resolve(true);

                delete self._unsubscribe_reqs[request];

            } else {

                if (request === 0) {

                    // router actively revoked our subscription
                    //
                    var details = msg[2];
                    var subscription_id = details.subscription;
                    var reason = details.reason;

                    if (subscription_id in self._subscriptions) {
                        var subs = self._subscriptions[subscription_id];
                        for (var i = 0; i < subs.length; ++i) {
                            subs[i].active = false;
                            subs[i]._on_unsubscribe.resolve(reason);
                        }
                        delete self._subscriptions[subscription_id];
                    } else {
                        self._protocol_violation("non-voluntary UNSUBSCRIBED received for non-existing subscription ID " + subscription_id);
                    }

                } else {
                    self._protocol_violation("UNSUBSCRIBED received for non-pending request ID " + request);
                }
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.UNSUBSCRIBED] = self._process_UNSUBSCRIBED;


        self._process_UNSUBSCRIBE_ERROR = function(msg) {
            //
            // process ERROR reply to UNSUBSCRIBE
            //
            var request = msg[2];
            if (request in self._unsubscribe_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._unsubscribe_reqs[request];

                var d = r[0];
                var subscription = r[1];

                d.reject(error);

                delete self._unsubscribe_reqs[request];

            } else {
                self._protocol_violation("UNSUBSCRIBE-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.UNSUBSCRIBE] = self._process_UNSUBSCRIBE_ERROR;


        self._process_PUBLISHED = function(msg) {
            //
            // process PUBLISHED reply to PUBLISH
            //
            var request = msg[1];
            var publication = msg[2];

            if (request in self._publish_reqs) {

                var r = self._publish_reqs[request];

                var d = r[0];
                var options = r[1];

                var pub = new Publication(publication);
                d.resolve(pub);

                delete self._publish_reqs[request];

            } else {
                self._protocol_violation("PUBLISHED received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.PUBLISHED] = self._process_PUBLISHED;


        self._process_PUBLISH_ERROR = function(msg) {
            //
            // process ERROR reply to PUBLISH
            //
            var request = msg[2];
            if (request in self._publish_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._publish_reqs[request];

                var d = r[0];
                var options = r[1];

                d.reject(error);

                delete self._publish_reqs[request];

            } else {
                self._protocol_violation("PUBLISH-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.PUBLISH] = self._process_PUBLISH_ERROR;


        self._process_EVENT = function(msg) {
            //
            // process EVENT message
            //
            // [EVENT, SUBSCRIBED.Subscription|id, PUBLISHED.Publication|id, Details|dict, PUBLISH.Arguments|list, PUBLISH.ArgumentsKw|dict]

            var subscription = msg[1];

            if (subscription in self._subscriptions) {

                var publication = msg[2];
                var details = msg[3];

                var args = msg[4] || [];
                var kwargs = msg[5] || {};

                var subs = self._subscriptions[subscription];

                // we want to provide the subscription topic to the handler, and may need to get this
                // from one of the subscription handler objects attached to the subscription
                // since for non-pattern subscriptions this is not sent over the wire
                var ed = new Event(publication, details.publisher, details.topic || subs[0].topic);

                for (var i = 0; i < subs.length; ++i) {
                    try {
                        subs[i].handler(args, kwargs, ed);
                    } catch (e) {
                        log.debug("Exception raised in event handler", e);
                    }
                }

            } else {
                self._protocol_violation("EVENT received for non-subscribed subscription ID " + subscription);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.EVENT] = self._process_EVENT;


        self._process_REGISTERED = function(msg) {
            //
            // process REGISTERED reply to REGISTER
            //
            var request = msg[1];
            var registration = msg[2];

            if (request in self._register_reqs) {

                var r = self._register_reqs[request];

                var d = r[0];
                var procedure = r[1];
                var endpoint = r[2];
                var options = r[3];

                var reg = new Registration(procedure, endpoint, options, self, registration);

                self._registrations[registration] = reg;

                d.resolve(reg);

                delete self._register_reqs[request];

            } else {
                self._protocol_violation("REGISTERED received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.REGISTERED] = self._process_REGISTERED;


        self._process_REGISTER_ERROR = function(msg) {
            //
            // process ERROR reply to REGISTER
            //
            var request = msg[2];
            if (request in self._register_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._register_reqs[request];

                var d = r[0];

                d.reject(error);

                delete self._register_reqs[request];

            } else {
                self._protocol_violation("REGISTER-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.REGISTER] = self._process_REGISTER_ERROR;


        self._process_UNREGISTERED = function(msg) {
            //
            // process UNREGISTERED reply to UNREGISTER
            //
            var request = msg[1];

            if (request in self._unregister_reqs) {

                var r = self._unregister_reqs[request];

                var d = r[0];
                var registration = r[1];

                if (registration.id in self._registrations) {
                    delete self._registrations[registration.id];
                }

                registration.active = false;
                d.resolve();

                delete self._unregister_reqs[request];

            } else {

                if (request === 0) {

                    // the router actively revoked our registration
                    //
                    var details = msg[2];
                    var registration_id = details.registration;
                    var reason = details.reason;

                    if (registration_id in self._registrations) {
                        var registration = self._registrations[registration_id];
                        registration.active = false;
                        registration._on_unregister.resolve(reason);
                        delete self._registrations[registration_id];
                    } else {
                        self._protocol_violation("non-voluntary UNREGISTERED received for non-existing registration ID " + registration_id);
                    }

                } else {
                    self._protocol_violation("UNREGISTERED received for non-pending request ID " + request);
                }
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.UNREGISTERED] = self._process_UNREGISTERED;


        self._process_UNREGISTER_ERROR = function(msg) {
            //
            // process ERROR reply to UNREGISTER
            //
            var request = msg[2];
            if (request in self._unregister_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._unregister_reqs[request];

                var d = r[0];
                var registration = r[1];

                d.reject(error);

                delete self._unregister_reqs[request];

            } else {
                self._protocol_violation("UNREGISTER-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.UNREGISTER] = self._process_UNREGISTER_ERROR;


        self._process_RESULT = function(msg) {
            //
            // process RESULT reply to CALL
            //
            var request = msg[1];
            if (request in self._call_reqs) {

                var details = msg[2];

                var args = msg[3] || [];
                var kwargs = msg[4] || {};

                // maybe wrap complex result:
                var result = null;
                if (args.length > 1 || Object.keys(kwargs).length > 0) {
                    // wrap complex result is more than 1 positional result OR
                    // non-empty keyword result
                    result = new Result(args, kwargs);
                } else if (args.length > 0) {
                    // single positional result
                    result = args[0];
                }

                var r = self._call_reqs[request];

                var d = r[0];
                var options = r[1];

                if (details.progress) {
                    if (options && options.receive_progress) {
                        d.notify(result);
                    }
                } else {
                    d.resolve(result);
                    delete self._call_reqs[request];
                }
            } else {
                self._protocol_violation("CALL-RESULT received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.RESULT] = self._process_RESULT;


        self._process_CALL_ERROR = function(msg) {
            //
            // process ERROR reply to CALL
            //
            var request = msg[2];
            if (request in self._call_reqs) {

                var details = msg[3];
                var error = new Error(msg[4], msg[5], msg[6]);

                var r = self._call_reqs[request];

                var d = r[0];
                var options = r[1];

                d.reject(error);

                delete self._call_reqs[request];

            } else {
                self._protocol_violation("CALL-ERROR received for non-pending request ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.ERROR][MSG_TYPE.CALL] = self._process_CALL_ERROR;


        self._process_INVOCATION = function(msg) {
            //
            // process INVOCATION message
            //
            // [INVOCATION, Request|id, REGISTERED.Registration|id, Details|dict, CALL.Arguments|list, CALL.ArgumentsKw|dict]
            //
            var request = msg[1];
            var registration = msg[2];

            var details = msg[3];
            // receive_progress
            // timeout
            // caller

            if (registration in self._registrations) {

                var endpoint = self._registrations[registration].endpoint;

                var args = msg[4] || [];
                var kwargs = msg[5] || {};

                // create progress function for invocation
                //
                var progress = null;
                if (details.receive_progress) {

                    progress = function(args, kwargs) {
                        var progress_msg = [MSG_TYPE.YIELD, request, { progress: true }];

                        args = args || [];
                        kwargs = kwargs || {};

                        var kwargs_len = Object.keys(kwargs).length;
                        if (args.length || kwargs_len) {
                            progress_msg.push(args);
                            if (kwargs_len) {
                                progress_msg.push(kwargs);
                            }
                        }
                        self._send_wamp(progress_msg);
                    }
                };

                var cd = new Invocation(details.caller, progress, details.procedure);

                // We use the following whenjs call wrapper, which automatically
                // wraps a plain, non-promise value in a (immediately resolved) promise
                //
                // See: https://github.com/cujojs/when/blob/master/docs/api.md#fncall
                //
                when_fn.call(endpoint, args, kwargs, cd).then(

                    function(res) {
                        // construct YIELD message
                        // FIXME: Options
                        //
                        var reply = [MSG_TYPE.YIELD, request, {}];

                        if (res instanceof Result) {
                            var kwargs_len = Object.keys(res.kwargs).length;
                            if (res.args.length || kwargs_len) {
                                reply.push(res.args);
                                if (kwargs_len) {
                                    reply.push(res.kwargs);
                                }
                            }
                        } else {
                            reply.push([res]);
                        }

                        // send WAMP message
                        //
                        self._send_wamp(reply);
                    },

                    function(err) {
                        // construct ERROR message
                        // [ERROR, REQUEST.Type|int, REQUEST.Request|id, Details|dict, Error|uri, Arguments|list, ArgumentsKw|dict]

                        var reply = [MSG_TYPE.ERROR, MSG_TYPE.INVOCATION, request, {}];

                        if (err instanceof Error) {

                            reply.push(err.error);

                            var kwargs_len = Object.keys(err.kwargs).length;
                            if (err.args.length || kwargs_len) {
                                reply.push(err.args);
                                if (kwargs_len) {
                                    reply.push(err.kwargs);
                                }
                            }
                        } else {
                            reply.push('wamp.error.runtime_error');
                            reply.push([err]);
                        }

                        // send WAMP message
                        //
                        self._send_wamp(reply);
                    }
                );

            } else {
                self._protocol_violation("INVOCATION received for non-registered registration ID " + request);
            }
        };
        self._MESSAGE_MAP[MSG_TYPE.INVOCATION] = self._process_INVOCATION;


        // callback fired by WAMP transport on receiving a WAMP message
        //
        self._socket.onmessage = function(msg) {

            var msg_type = msg[0];

            // WAMP session not yet open
            //
            if (!self._id) {

                // the first message must be WELCOME, ABORT or CHALLENGE ..
                //
                if (msg_type === MSG_TYPE.WELCOME) {

                    self._id = msg[1];

                    // determine actual set of advanced features that can be used
                    //
                    var rf = msg[2];
                    self._features = {};

                    if (rf.roles.broker) {
                        // "Basic Profile" is mandatory
                        self._features.subscriber = {};
                        self._features.publisher = {};

                        // fill in features that both peers support
                        if (rf.roles.broker.features) {

                            for (var att in WAMP_FEATURES.publisher.features) {
                                self._features.publisher[att] = WAMP_FEATURES.publisher.features[att] &&
                                    rf.roles.broker.features[att];
                            }

                            for (var att in WAMP_FEATURES.subscriber.features) {
                                self._features.subscriber[att] = WAMP_FEATURES.subscriber.features[att] &&
                                    rf.roles.broker.features[att];
                            }
                        }
                    }

                    if (rf.roles.dealer) {
                        // "Basic Profile" is mandatory
                        self._features.caller = {};
                        self._features.callee = {};

                        // fill in features that both peers support
                        if (rf.roles.dealer.features) {

                            for (var att in WAMP_FEATURES.caller.features) {
                                self._features.caller[att] = WAMP_FEATURES.caller.features[att] &&
                                    rf.roles.dealer.features[att];
                            }

                            for (var att in WAMP_FEATURES.callee.features) {
                                self._features.callee[att] = WAMP_FEATURES.callee.features[att] &&
                                    rf.roles.dealer.features[att];
                            }
                        }
                    }

                    if (self.onjoin) {
                        self.onjoin(msg[2]);
                    }

                } else if (msg_type === MSG_TYPE.ABORT) {

                    var details = msg[1];
                    var reason = msg[2];

                    if (self.onleave) {
                        self.onleave(reason, details);
                    }

                } else if (msg_type === MSG_TYPE.CHALLENGE) {

                    if (self._onchallenge) {

                        var method = msg[1];
                        var extra = msg[2];

                        when_fn.call(self._onchallenge, self, method, extra).then(
                            function(signature) {
                                let msg = [MSG_TYPE.AUTHENTICATE, signature, {}];
                                self._send_wamp(msg);
                            },
                            function(err) {
                                log.debug("onchallenge() raised:", err);

                                var msg = [MSG_TYPE.ABORT, { message: "sorry, I cannot authenticate (onchallenge handler raised an exception)" }, "wamp.error.cannot_authenticate"];
                                self._send_wamp(msg);
                                self._socket.close(1000);
                            }
                        );
                    } else {
                        log.debug("received WAMP challenge, but no onchallenge() handler set");

                        let msg = [MSG_TYPE.ABORT, { message: "sorry, I cannot authenticate (no onchallenge handler set)" }, "wamp.error.cannot_authenticate"];
                        self._send_wamp(msg);
                        self._socket.close(1000);
                    }

                } else {
                    self._protocol_violation("unexpected message type " + msg_type);
                }

                // WAMP session is open
                //
            } else {

                if (msg_type === MSG_TYPE.GOODBYE) {

                    if (!self._goodbye_sent) {

                        var reply = [MSG_TYPE.GOODBYE, {}, "wamp.error.goodbye_and_out"];
                        self._send_wamp(reply);
                    }

                    self._id = null;
                    self._realm = null;
                    self._features = null;

                    var details = msg[1];
                    var reason = msg[2];

                    if (self.onleave) {
                        self.onleave(reason, details);
                    }

                } else {

                    if (msg_type === MSG_TYPE.ERROR) {

                        var request_type = msg[1];
                        if (request_type in self._MESSAGE_MAP[MSG_TYPE.ERROR]) {

                            self._MESSAGE_MAP[msg_type][request_type](msg);

                        } else {

                            self._protocol_violation("unexpected ERROR message with request_type " + request_type);
                        }

                    } else {

                        if (msg_type in self._MESSAGE_MAP) {

                            self._MESSAGE_MAP[msg_type](msg);

                        } else {

                            self._protocol_violation("unexpected message type " + msg_type);
                        }
                    }
                }
            }
        };

        // session object constructed .. track creation time
        //
        if ('performance' in global && 'now' in performance) {
            self._created = performance.now();
        } else {
            self._created = Date.now();
        }
    };


    private _protocol_violation = function(reason: string) {
        log.debug("failing transport due to protocol violation: " + reason);
        this._socket.close(1002, "protocol violation: " + reason);
    }

    private _send_wamp(msg) {
        log.debug(msg);
        // forward WAMP message to be sent to WAMP transport
        this._socket.send(msg);
    };

    /**
     * Called when the _Broker_ answers to a SUBSCRIBE message with a "SUBSCRIBED"
     * response.
     *
     * This resolves the promises that expresses the awaited SUBSCRIBED response and creates
     * a new subscription.
     *
     * @see https://tools.ietf.org/html/draft-oberstet-hybi-tavendo-wamp-02
     *      Section 8.1.2
     *
     * OPENQUESTION: Timeouts?
     * OPENQUESTION: Can the promise be rejected from anywhere if no answer arrives?
     *
    */
    private _process_SUBSCRIBED = (msg: [number, number, number]) => {
        //
        // process SUBSCRIBED reply to SUBSCRIBE
        //
        var request: number = msg[1];
        var subscription: number = msg[2];

        if (request in this._subscribe_reqs) {

            var [d, topic, handler, options] = this._subscribe_reqs[request];

            if (!(subscription in this._subscriptions)) {
                this._subscriptions[subscription] = [];
            }
            var sub = new Subscription(topic, handler, options, this, subscription);
            this._subscriptions[subscription].push(sub);

            d.resolve(sub);

            delete this._subscribe_reqs[request];

        } else {
            this._protocol_violation("SUBSCRIBED received for non-pending request ID " + request);
        }
    };


    log() {
        var self = this;

        if ('console' in global) {

            var header = null;
            if (self._id && self._created) {

                var now = null;
                if ('performance' in global && 'now' in performance) {
                    now = performance.now() - self._created;
                } else {
                    now = Date.now() - self._created;
                }

                header = "WAMP session " + self._id + " on '" + self._realm + "' at " + Math.round(now * 1000) / 1000 + " ms";
            } else {
                header = "WAMP session";
            }

            if ('group' in console) {
                console.group(header);
                for (var i = 0; i < arguments.length; i += 1) {
                    console.log(arguments[i]);
                }
                console.groupEnd();
            } else {
                var items = [header + ": "];
                for (var i = 0; i < arguments.length; i += 1) {
                    items.push(arguments[i]);
                }
                console.log.apply(console, items);
            }
        }
    }


    join(realm, authmethods, authid) {

        util.assert(typeof realm === 'string', "Session.join: <realm> must be a string");
        util.assert(!authmethods || Array.isArray(authmethods), "Session.join: <authmethods> must be an array []");
        util.assert(!authid || typeof authid === 'string', "Session.join: <authid> must be a string");

        var self = this;

        if (self.isOpen) {
            throw "session already open";
        }

        self._goodbye_sent = false;
        self._realm = realm;

        var details: any = {};
        details.roles = WAMP_FEATURES;

        if (authmethods) {
            details.authmethods = authmethods;
        }
        if (authid) {
            details.authid = authid;
        }

        var msg = [MSG_TYPE.HELLO, realm, details];
        self._send_wamp(msg);
    }


    leave(reason, message) {

        util.assert(!reason || typeof reason === 'string', "Session.leave: <reason> must be a string");
        util.assert(!message || typeof message === 'string', "Session.leave: <message> must be a string");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        if (!reason) {
            reason = "wamp.close.normal";
        }

        var details: any = {};
        if (message) {
            details.message = message;
        }

        var msg = [MSG_TYPE.GOODBYE, details, reason];
        self._send_wamp(msg);
        self._goodbye_sent = true;
    }


    call(procedure, args, kwargs, options): Promise<any> {

        util.assert(typeof procedure === 'string', "Session.call: <procedure> must be a string");
        util.assert(!args || Array.isArray(args), "Session.call: <args> must be an array []");
        util.assert(!kwargs || kwargs instanceof Object, "Session.call: <kwargs> must be an object {}");
        util.assert(!options || options instanceof Object, "Session.call: <options> must be an object {}");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        options = options || {};

        // only set option if user hasn't set a value and global option is "on"
        if (options.disclose_me === undefined && self._caller_disclose_me) {
            options.disclose_me = true;
        }

        // create and remember new CALL request
        //
        var d = self._defer();
        var request = newid();
        self._call_reqs[request] = [d, options];

        // construct CALL message
        //
        var msg = [MSG_TYPE.CALL, request, options, self.resolve(procedure)];
        if (args) {
            msg.push(args);
            if (kwargs) {
                msg.push(kwargs);
            }
        } else if (kwargs) {
            msg.push([]);
            msg.push(kwargs);
        }

        // send WAMP message
        //
        self._send_wamp(msg);

        if (d.promise.then) {
            // whenjs has the actual user promise in an attribute
            return d.promise;
        } else {
            return d;
        }
    }


    publish(topic: string, args: Array<any>, kwargs: Object, options?): Promise<any> {

        util.assert(typeof topic === 'string', "Session.publish: <topic> must be a string");
        util.assert(!args || Array.isArray(args), "Session.publish: <args> must be an array []");
        util.assert(!kwargs || kwargs instanceof Object, "Session.publish: <kwargs> must be an object {}");
        util.assert(!options || options instanceof Object, "Session.publish: <options> must be an object {}");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        options = options || {};

        // only set option if user hasn't set a value and global option is "on"
        if (options.disclose_me === undefined && self._publisher_disclose_me) {
            options.disclose_me = true;
        }

        // create and remember new PUBLISH request
        //
        var d = null;
        var request = newid();
        if (options.acknowledge) {
            d = self._defer();
            self._publish_reqs[request] = [d, options];
        }

        // construct PUBLISH message
        //
        var msg = [MSG_TYPE.PUBLISH, request, options, self.resolve(topic)];
        if (args) {
            msg.push(args);
            if (kwargs) {
                msg.push(kwargs);
            }
        } else if (kwargs) {
            msg.push([]);
            msg.push(kwargs);
        }

        // send WAMP message
        //
        self._send_wamp(msg);

        if (d) {
            if (d.promise.then) {
                // whenjs has the actual user promise in an attribute
                return d.promise;
            } else {
                return d;
            }
        }
    }


    subscribe(topic: string, handler: Function, options?: Object): Promise<any> {

        util.assert(typeof topic === 'string', "Session.subscribe: <topic> must be a string");
        util.assert(typeof handler === 'function', "Session.subscribe: <handler> must be a function");
        util.assert(!options || options instanceof Object, "Session.subscribe: <options> must be an object {}");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        // create an remember new SUBSCRIBE request
        //
        var request = newid();
        var d = self._defer();
        self._subscribe_reqs[request] = [d, topic, handler, options];

        // construct SUBSCRIBE message
        //
        var msg: Array<any> = [MSG_TYPE.SUBSCRIBE, request];
        if (options) {
            msg.push(options);
        } else {
            msg.push({});
        }
        msg.push(self.resolve(topic));

        // send WAMP message
        //
        self._send_wamp(msg);

        if (d.promise.then) {
            // whenjs has the actual user promise in an attribute
            return d.promise;
        } else {
            return d;
        }
    }


    register(procedure: string, endpoint: Function, options: Object): Promise<any> {

        util.assert(typeof procedure === 'string', "Session.register: <procedure> must be a string");
        util.assert(typeof endpoint === 'function', "Session.register: <endpoint> must be a function");
        util.assert(!options || options instanceof Object, "Session.register: <options> must be an object {}");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        // create an remember new REGISTER request
        //
        var request = newid();
        var d = self._defer();
        self._register_reqs[request] = [d, procedure, endpoint, options];

        // construct REGISTER message
        //
        var msg: any = [MSG_TYPE.REGISTER, request];
        if (options) {
            msg.push(options);
        } else {
            msg.push({});
        }
        msg.push(self.resolve(procedure));

        // send WAMP message
        //
        self._send_wamp(msg);

        if (d.promise.then) {
            // whenjs has the actual user promise in an attribute
            return d.promise;
        } else {
            return d as any;
        }
    }


    unsubscribe(subscription: Subscription) {

        util.assert(subscription instanceof Subscription, "Session.unsubscribe: <subscription> must be an instance of class autobahn.Subscription");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        if (!subscription.active || !(subscription.id in self._subscriptions)) {
            throw "subscription not active";
        }

        var subs = self._subscriptions[subscription.id];
        var i = subs.indexOf(subscription);

        if (i === -1) {
            throw "subscription not active";
        }

        // remove handler subscription
        subs.splice(i, 1);
        subscription.active = false;

        var d = self._defer();

        if (subs.length) {
            // there are still handlers on the subscription ..
            d.resolve(false);

        } else {

            // no handlers left ..

            // create and remember new UNSUBSCRIBE request
            //
            var request = newid();
            self._unsubscribe_reqs[request] = [d, subscription.id];

            // construct UNSUBSCRIBE message
            //
            var msg = [MSG_TYPE.UNSUBSCRIBE, request, subscription.id];

            // send WAMP message
            //
            self._send_wamp(msg);
        }

        if (d.promise.then) {
            // whenjs has the actual user promise in an attribute
            return d.promise;
        } else {
            return d;
        }
    }


    unregister(registration: Registration) {

        util.assert(registration instanceof Registration, "Session.unregister: <registration> must be an instance of class autobahn.Registration");

        var self = this;

        if (!self.isOpen) {
            throw "session not open";
        }

        if (!registration.active || !(registration.id in self._registrations)) {
            throw "registration not active";
        }

        // create and remember new UNREGISTER request
        //
        var request = newid();
        var d = self._defer();
        self._unregister_reqs[request] = [d, registration];

        // construct UNREGISTER message
        //
        var msg = [MSG_TYPE.UNREGISTER, request, registration.id];

        // send WAMP message
        //
        self._send_wamp(msg);

        if (d.promise.then) {
            // whenjs has the actual user promise in an attribute
            return d.promise;
        } else {
            return d;
        }
    }


    prefix(prefix: string, uri: string) {

        util.assert(typeof prefix === 'string', "Session.prefix: <prefix> must be a string");
        util.assert(!uri || typeof uri === 'string', "Session.prefix: <uri> must be a string or falsy");

        var self = this;

        if (uri) {
            self._prefixes[prefix] = uri;
        } else {
            if (prefix in self._prefixes) {
                delete self._prefixes[prefix];
            }
        }
    }


    resolve(curie: string) {

        util.assert(typeof curie === 'string', "Session.resolve: <curie> must be a string");

        var self = this;

        // skip if not a CURIE
        var i = curie.indexOf(":");
        if (i >= 0) {
            var prefix = curie.substring(0, i);
            if (prefix in self._prefixes) {
                return self._prefixes[prefix] + '.' + curie.substring(i + 1);
            } else {
                throw "cannot resolve CURIE prefix '" + prefix + "'";
            }
        } else {
            return curie;
        }
    }
}

export default Session;
