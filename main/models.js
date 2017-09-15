/**
 * Created by Andrew on 27.06.2014.
 */

var events = {};
_.extend(events, Backbone.Events);

var DevInfo = Backbone.Model.extend({url: '/cgi/dev_info'});
var devInfo = new DevInfo();

var ECRStatus = Backbone.Model.extend({
	url:        '/cgi/state',
	defaults:   {'online': false, 'name': 'Device', dev_fn: '-', dev_nn: '-', dev_dat: '-', dev_ver: '-', dev_id: '-'},
	refresh:    function () {
		var $this = this;
		this.fetch({remove: false}).always(function (x, txt) {
			$this.syncDate.call($this, txt == 'success')
		});
	},
	initialize: function () {
		this.nextTime = new Date();
		devInfo.on('change', function () {
			this.set(devInfo.attributes);
		}, this);
		this.on('change:name', function () {
			devInfo.fetch();
		});
		events.on('tick', this.tick, this);
		this.refresh();
	},
	syncDate:   function (ok) {
		this.set('online', ok);
		var d = this.get('time');
		if (ok && _.isNumber(d)) {
			this.fetch_ok = true;
			this.set('time', new Date(d * 1000));
		}
		setTimeout(_.bind(this.refresh, this), 60000);
	},
	getTime:    function () {
		var d = this.get('time');
		return new Date(_.isNumber(d) ? d * 1000 : d.getTime());
	},
	tick:       function () {
		if (this.fetch_ok) {
			this.fetch_ok = false;
			return;
		}
		var d = this.get('time');
		this.set('time', new Date(_.isNumber(d) ? d * 1000 : (d.getTime() + 1000)));
	},
	merge:      function () {
		this.set(devInfo.attributes);
	}
});

var FiscalCell = Backbone.Model.extend({
	initialize:            function () {
		var $this = this;
		$.getJSON("/cgi/tbl/FDay?s=1&e=2", function (data) {
			if (_.isArray(data)) data = data[0];
			if (_.isObject(data)) {
				if ('id' in data) {
					$this.set('firstRep', data.id);
				} else {
					$this.unset('firstRep');
				}
				if ('Date' in data) {
					$this.set('firstTime', new Date(data.Date * 1000));
				} else {
					$this.unset('firstTime');
				}
			}
			//$this.set('fiscalize',$this.has('firstRep'));
		});
	},
	loadFiscalizationData: function () {
		var promises = [];
		promises.push($.ajax({
			url:      '/cgi/tbl/FTax',
			dataType: 'json'
		}));
		promises.push($.ajax({
			url:      '/cgi/tbl/FSbr',
			dataType: 'json'
		}));
		return $.when.apply($, promises);
	},
	initializeFiscalMode:  function () {
		var deferred = $.Deferred();
		var $this    = this;
		$.getJSON("/cgi/state", function (response) {
			/**
			 * Check if the device is in the fiscal mode
			 */
			if (!_.isUndefined(response["FskMode"])) {
				$this.set("isFiscalPrinter", true);
			}
			String.prototype.contains = function (it) {
				return this.indexOf(it) != -1;
			};
			if (response["model"].contains("ГНОМ")) {
				window.isGNOME = true;
			}
			/**
			 * Load last fiscalization report
			 */
			$.getJSON("/cgi/tbl/FDay?s=-1", function (data) {
				if (_.isArray(data)) data = data[0];
				if (_.isObject(data)) {
					if ('id' in data) {
						$this.set('lastRep', data.id);
					}
					if ('Date' in data) {
						$this.set('lastTime', new Date(data.Date * 1000));
					}
				}
				/**
				 * If the response has a field fiscalization
				 * than set it as fiscalization
				 */
				if (!_.isUndefined(response["Fiscalization"])) {
					$this.set("fiscalize", response["Fiscalization"]);
					return deferred.resolve();
				}
				else {
					/**
					 * Load data from FTax and FSbr
					 * If both tables are empty - not fiscalized
					 * Else - fiscalized
					 */
					$this.loadFiscalizationData().then(function () {
						var isFiscalized = false;
						_.each(arguments, function (response) {
							if (_.isArray(response) && response[1] == 'success' && _.isObject(response[0]) && !_.isEmpty(response[0])) {
								isFiscalized = true;
							}
						});
						$this.set("fiscalize", isFiscalized);
						return deferred.resolve();
					});
				}
			});

		});
		return deferred.promise();
	}

});

var TableModel = Backbone.Model.extend({
	/*validate:function(attrs,options) {
	 for(name in attrs) {

	 }
	 },*/
	initialize: function (attrs, opts) {
		if (opts && opts.schema) this.schema = opts.schema;
		if (opts && opts.urlRoot) this.urlRoot = opts.urlRoot;
	},
	sync:       function (method, model, options) {
		if (this.schema.syncCol && (method === 'create' || method === 'update' || method === 'patch')) {
			var a = (options && options.attrs) || options;
			_.each(_.intersection(_.keys(a), this.schema.syncCol), function (e) {
				a[e] = schema.parseOut(schema.typeCol(this.schema, e), a[e]);
			}, this);
		}
		return Backbone.sync(method, model, options);
	},
	parse:      function (response/*,option*/) {
		//console.log('parse',response,option,this.schema);
		if (_.isArray(response)) {
			_.each(response, function (el) {
				if (_.isObject(el)) this.parseRow(el);
			}, this);
		} else if (_.isObject(response)) {
			this.parseRow(response);
		}
		return response;
	},
	parseRow:   function (o) {
		schema.fixIn(this.schema, o);
		if (_.has(o, 'err')) {
			var $this = this;
			schema.parseError(o.err, function (msg, field) {
				if ($this.collection) {
					$this.collection.trigger('err', $this, msg, field);
				} else {
					$this.trigger('err', $this, msg, field);
				}
			});
			delete o.err;
		}
	},
	isNew:      function () {
		return this.newModel;
	}
});

var TableCollection = Backbone.PageableCollection.extend({
	state:               {
		pageSize: 20,
		sortKey:  "updated",
		order:    1
	},
	mode:                "client",
	initialize:          function (models, options) {
		if (options && options.url) this.url = options.url;
		if (options && !_.isUndefined(options.mode)) {
			this.mode = options.mode;
		}
	},
	parse:               function (resp/*,options*/) {
		var key = this.model.prototype.schema.get('key') || 'id';
		if (_.isArray(resp)) {
			var toRemove = [];
			_.each(resp, function (el) {
				if (!key in el) {
					toRemove.push(el);
					if ('err' in el) {
						var $this = this;
						schema.parseError(el.err, function (msg, field) {
							$this.trigger('err', el, msg, field);
						});
					}
				}
			});
			resp         = _.difference(resp, toRemove);
		} else {
			if (!key in resp) {
				if ('err' in resp) {
					var $this = this;
					schema.parseError(resp.err, function (msg, field) {
						$this.trigger('err', el, msg, field);
					});
				}
				return [];
			}
		}
		return resp;
	},
	syncSave:            function (errorRep) {
		var toSync   = [];
		var toAdd    = [];
		var cols     = _.map(this.model.prototype.schema.get('elems'), function (el) {
			return (("editable" in el) && !el.editable) ? 0 : el.name;
		});
		cols         = _.compact(cols);
		this.each(function (model) {
			if (model.hasChanged() || model.isNew()) {
				if (model.isNew()) {
					var k = model.keys();
					var c = _.intersection(k, cols);
					if (c.length == cols.length) {
						toAdd.push(model.attributes);
						//model.newModel = false;
					}
				} else {
					var e                = {};
					e[model.idAttribute] = model.id;
					e                    = _.extend(e, model.changedAttributes());
					toSync.push(e);
				}
			}
		}, this);
		var promises = [];
		var key      = this.model.prototype.schema.get('key') || 'id';
		if (toSync.length) {
			var err_id = null;
			var err    = false;
			var sp     = new $.Deferred();
			this.sync('patch', this, {
				attrs:   toSync,
				context: this,
				success: function (resp) {
					if (_.isObject(resp) && _.isEmpty(resp)) {
						_.each(toSync, function (el) {
							var e = this.get(el[key]);
							e && e.set({}, {silent: true});
						}, this);
					}
					this.on('err', function (model, msg, field) {
						if (errorRep) {
							errorRep({msg: msg, fld: field, row: model.id})
						}
						err_id = model.id;
						err    = true;
					}, this);
					this.set(resp, {remove: false, parse: true, silent: true});
					this.off('err', null, this);
					if (err) {
						if (toSync.length > 1 && err_id) {
							_.find(toSync, function (el) {
								if (el[key] == err_id) return true;
								var e = this.get(el[key]);
								e && e.set({}, {silent: true});
								return false;
							});
						}
						sp.reject();
					} else sp.resolve();
				},
				error:   function (xhr/*,status,error*/) {
					if (errorRep) errorRep({msg: xhrError(xhr)});
					sp.reject();
				}
			});
			promises.push(sp);
		}
		if (toAdd.length) {
			var err_ida = null;
			var erra    = false;
			var ap      = new $.Deferred();
			this.sync('create', this, {
				attrs:   toAdd,
				context: this,
				success: function (resp) {
					if (_.isObject(resp) && _.isEmpty(resp)) {
						_.each(toAdd, function (el) {
							var e = this.get(el[key]);
							if (e) {
								e.set({}, {silent: true});
								delete e.newModel;
							}
						}, this);
					} else {
						this.on('err', function (model, msg, field) {
							if (errorRep) {
								errorRep({msg: msg, fld: field, row: model.id})
							}
							err_ida = model.id;
							erra    = true;
						}, this);
						this.set(resp, {remove: false, parse: true, silent: true});
						this.off('err', null, this);
					}
					if (erra) {
						if (toAdd.length > 1 && err_id) {
							_.find(toAdd, function (el) {
								if (el[key] == err_ida) return true;
								var e = this.get(el[key]);
								if (e) {
									e.set({}, {silent: true});
									delete e.newModel;
								}
								return false;
							});
						}
						ap.reject();
					} else ap.resolve();
				},
				error:   function (xhr/*,status,error*/) {
					if (errorRep) errorRep({msg: xhrError(xhr)});
					ap.reject();
				}
			});
			promises.push(ap);
		}
		return (promises.length == 0) ? false : $.when.apply($, promises);
	},
	deleteRows:          function (models) {
		_.each(models, function (m) {
			m.destroy({wait: true});
		});
	},
	newRow:              function () {
		this.unshift({}).newModel = true;
	},
	syncSaveSynchronize: function (errorRep) {
		var toSync   = [];
		var toAdd    = [];
		var cols     = _.map(this.model.prototype.schema.get('elems'), function (el) {
			return (("editable" in el) && !el.editable) ? 0 : el.name;
		});
		cols         = _.compact(cols);
		this.each(function (model) {
			if (model.hasChanged() || model.isNew()) {
				if (model.isNew()) {
					var k = model.keys();
					var c = _.intersection(k, cols);
					if (c.length == cols.length) {
						toAdd.push(model.attributes);
						//model.newModel = false;
					}
				} else {
					var e                = {};
					e[model.idAttribute] = model.id;
					e                    = _.extend(e, model.changedAttributes());
					toSync.push(e);
				}
			}
		}, this);
		var self     = this;
		var deferred = $.Deferred();
		var key      = this.model.prototype.schema.get('key') || 'id';
		this.syncEditModels(toSync, errorRep, key).done(function () {
			self.syncCreateModels(toAdd, errorRep, key).done(function () {
				return deferred.resolve();
			}).fail(function (response) {
				return deferred.reject(response);
			});
		}).fail(function (response) {
			return deferred.reject(response);
		});
		return deferred.promise();
	},
	syncEditModels:      function (toSync, errorRep, key) {
		var deferred = $.Deferred();
		if (!_.isEmpty(toSync)) {
			var err_id = null;
			var err    = false;
			this.sync('patch', this, {
				attrs:   toSync,
				context: this,
				success: function (resp) {
					var responseReturn = _.clone(resp);
					responseReturn.key = key;
					if (_.isObject(resp) && _.isEmpty(resp)) {
						_.each(toSync, function (el) {
							var e = this.get(el[key]);
							e && e.set({}, {silent: true});
						}, this);
					}
					else {
						if (!_.isUndefined(resp['err'])) {
							err = true;
						}
					}
					this.on('err', function (model, msg, field) {
						if (errorRep) {
							errorRep({msg: msg, fld: field, row: model.id})
						}
						err_id = model.id;
						err    = true;
					}, this);
					this.set(resp, {remove: false, parse: true, silent: true});
					this.off('err', null, this);
					if (err) {
						if (toSync.length > 1 && err_id) {
							_.find(toSync, function (el) {
								if (el[key] == err_id) return true;
								var e = this.get(el[key]);
								e && e.set({}, {silent: true});
								return false;
							});
						}
						deferred.reject(responseReturn);
					} else deferred.resolve();
				},
				error:   function (xhr/*,status,error*/) {
					if (errorRep) errorRep({msg: xhrError(xhr)});
					deferred.reject();
				}
			});
		}
		else {
			return deferred.resolve();
		}
		return deferred.promise();
	},
	syncCreateModels:    function (toAdd, errorRep, key) {
		var deferred = $.Deferred();
		if (!_.isEmpty(toAdd)) {
			var err_ida = null;
			var erra    = false;
			this.sync('create', this, {
				attrs:   toAdd,
				context: this,
				success: function (resp) {
					var responseReturn = _.clone(resp);
					responseReturn.key = key;
					if (_.isObject(resp) && _.isEmpty(resp)) {
						_.each(toAdd, function (el) {
							var e = this.get(el[key]);
							if (e) {
								e.set({}, {silent: true});
								delete e.newModel;
							}
						}, this);
					} else {
						if ("err" in resp) {
							erra = true;
						}
						this.on('err', function (model, msg, field) {
							if (errorRep) {
								errorRep({msg: msg, fld: field, row: model.id})
							}
							err_ida = model.id;
							erra    = true;
						}, this);
						this.set(resp, {remove: false, parse: true, silent: true});
						this.off('err', null, this);
					}
					if (erra) {
						if (toAdd.length > 1 && err_ida) {
							_.find(toAdd, function (el) {
								if (el[key] == err_ida) return true;
								var e = this.get(el[key]);
								if (e) {
									e.set({}, {silent: true});
									delete e.newModel;
								}
								return false;
							});
						}
						deferred.reject(responseReturn);

					} else {
						deferred.resolve();
					}
				},
				error:   function (xhr/*,status,error*/) {
					if (errorRep) errorRep({msg: xhrError(xhr)});
					deferred.reject();
				}
			});
		}
		else {
			return deferred.resolve();
		}
		return deferred.promise();
	}
});

var NetworkInfo = Backbone.Collection.extend({
	url:     '/cgi/netifs',
	/*initialize: function(){

	 },*/
	refresh: function () {
		var d     = $.Deferred();
		var $this = this;
		this.fetch().done(function () {
			$this.remove($this.where({name: 'Loopback'}));
			if (gprsExists) {
				$.get('/cgi/mdm_info').done(function (data) {
					$this.add({name: 'GPRS', addr: data.ip});
					d.resolve();
				}).fail(function () {
					d.reject();
				});
			} else d.resolve();
		}).fail(function () {
			d.reject();
		});
		return d.promise();
	}
});

/**
 * NAP model
 */
var NapModel = Backbone.Model.extend({
	/**
	 * Common error message for the bad request
	 */
	errorMessage:    "Error while sending the request",

	/**
	 * Dropdowns which are used to form selects in forms
	 * @returns {{FDType: *[], EIKType: *[], OPID: *[], PSType: *, RCFD: *[]}}
	 */
	getDropdowns:    function () {
		return {
			FDType:  [
				{
					id:   1,
					name: t("Electronic cash register with fiscal memory")
				},
				{
					id:   2,
					name: t("Fiscal printer (FP)")
				},
				{
					id:   3,
					name: t("Electronic fiscal memory system for sales of liquid fuels")
				},
				{
					id:   4,
					name: t("Integrated automated trading management system")
				}
			],
			EIKType: [
				{
					id:   0,
					name: t("bulsat")
				},
				{
					id:   1,
					name: t("PIN")
				},
				{
					id:   2,
					name: t("FND")
				},
				{
					id:   3,
					name: t("work number")
				}
			],
			OPID:    [
				{
					id:   0,
					name: "Mtel"
				},
				{
					id:   1,
					name: "Globul"
				},
				{
					id:   2,
					name: "Vivacom"
				}
			],
			PSType:  getPSType(),
			RCFD:    [
				{
					name:  t("Dismantling the fiscal memory of FM is done in the following cases:"),
					items: [
						{
							id:   1,
							name: t("overflowing fiscal memory")
						},
						{
							id:   2,
							name: t("change of owner")
						},
						{
							id:   3,
							name: t("terminated registration of the University of Sofia at the initiative of the person")
						},
						{
							id:   4,
							name: t("scrapping FU")
						},
						{
							id:   5,
							name: t("damage to fiscal memory that prevents its reading")
						},
						{
							id:   6,
							name: t("error in a fiscal memory block")
						},
						{
							id:   7,
							name: t("fault in commissioning of FM")
						},
						{
							id:   8,
							name: t("after finishing ESFP testing in real terms")
						}
					]
				},
				{
					name:  t("Termination of activity:"),
					items: [
						{
							id:   9,
							name: t("termination of the activity of the person")
						},
						{
							id:   10,
							name: t("others")
						}
					]
				}
			]
		};
	},
	/**
	 * Get model data before page loading
	 * @returns {*}
	 */
	getEntity:       function () {
		var self     = this;
		var deferred = $.Deferred();
		$.ajax({
			url:      self.url,
			dataType: 'json',
			type:     'get',
			error:    function () {
				return deferred.reject(t(self.errorMessage));
			},
			success:  function (data) {
				if (_.isObject(data)) {
					/**
					 * Check if the response contains error property
					 */
					var response = self.isErrorResponse(data);
					if (response.isError) {
						return deferred.reject(response.message);
					}
					for (var property in data) {
						self.set(property, data[property]);
					}
				}
				return deferred.resolve();
			}
		});
		return deferred.promise();
	},
	/**
	 * Upload model data to the server
	 * @returns {*}
	 */
	sendEntity:      function () {
		var self     = this;
		var deferred = $.Deferred();
		$.ajax({
			url:      self.url,
			dataType: 'json',
			type:     'POST',
			data:     JSON.stringify(self.toJSON()),
			timeout:  90000,
			error:    function () {
				return deferred.reject(t(self.errorMessage));
			},
			success:  function (data) {
				var response = self.isErrorResponse(data);
				if (response.isError) {
					return deferred.reject(response.message);
				}
				return deferred.resolve(response);
			}
		});
		return deferred.promise();
	},
	/**
	 * Check if the response contains error
	 * @param response
	 * @returns {{isError: boolean, message: string}}
	 */
	isErrorResponse: function (response) {
		var result = {
			isError: false,
			message: ""
		};
		if (_.isObject(response)) {
			if (response.hasOwnProperty("Error") && response["Error"] != 0) {
				var errorMessage = response["Error"];
				/**
				 * If the error code has length more than 3 characters
				 * get just last 2 symbols
				 */
				if (!_.isEmpty(errorMessage) && errorMessage.length > 3) {
					errorMessage = "x" + errorMessage.substr(errorMessage.length - 2, errorMessage.length - 1);
				}
				result.message = _.isEmpty(schema.error(errorMessage)) ? t(self.errorMessage) : schema.error(errorMessage);
				result.isError = true;
			}
		}
		return result;
	}

});

/**
 * Registration model
 */
var NapRegModel = NapModel.extend({
	//defaults: {
	//	FDType:                    "",
	//	EIK:                       "",
	//	EIKType:                   "",
	//	FDIN:                      "",
	//	FMIN:                      "",
	//	FDCert:                    "",
	//	IMSI:                      "",
	//	MSISDN:                    "",
	//	OPID:                      "",
	//	OrgName:                   "",
	//	PSNum:                     "",
	//	PSType:                    "",
	//	SEKATTE:                   "",
	//	Settl:                     "",
	//	AEkatte:                   "",
	//	Area:                      "",
	//	StreetCode:                "",
	//	Street:                    "",
	//	StrNo:                     "",
	//	Block:                     "",
	//	En:                        "",
	//	Fl:                        "",
	//	Ap:                        "",
	//	PSName:                    "",
	//	ServiceEIK:                "",
	//	ServiceEIKType:            "",
	//	ServiceContractExpiration: "",
	//	SOD:                       ""
	//},
	url:      '/cgi/reg_nap'
});

/**
 * Deregistration model
 */
var NapDeregModel = NapModel.extend({
	//defaults: {
	//	FDType:  "",
	//	EIK:     "",
	//	EIKType: "",
	//	FDIN:    "",
	//	FMIN:    "",
	//	FDRID:   "",
	//	RCFD:    ""
	//},
	url:      '/cgi/dereg_nap'
});

/**
 * Change registration model
 */
var NapChangeRegModel = NapModel.extend({
	//defaults: {
	//	FDType:                    "",
	//	EIK:                       "",
	//	EIKType:                   "",
	//	FDIN:                      "",
	//	FMIN:                      "",
	//	FDCert:                    "",
	//	IMSI:                      "",
	//	MSISDN:                    "",
	//	OPID:                      "",
	//	OrgName:                   "",
	//	PSNum:                     "",
	//	PSType:                    "",
	//	SEKATTE:                   "",
	//	Settl:                     "",
	//	AEkatte:                   "",
	//	Area:                      "",
	//	StreetCode:                "",
	//	Street:                    "",
	//	StrNo:                     "",
	//	Block:                     "",
	//	En:                        "",
	//	Fl:                        "",
	//	Ap:                        "",
	//	PSName:                    "",
	//	ServiceEIK:                "",
	//	ServiceEIKType:            "",
	//	ServiceContractExpiration: "",
	//	SOD:                       ""
	//},
	url:      '/cgi/chg_reg_nap'
});

/**
 * Get info model
 */
var NapGetInfoModel = NapModel.extend({
	//defaults: {
	//	EIK:     "",
	//	EIKType: "",
	//	IMSI:    "",
	//	MSISDN:  "",
	//	OPID:    ""
	//},
	url:      '/cgi/info_nap'
});