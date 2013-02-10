/*---------------------------------------------------------------
	:: waterline-mysql
	-> adapter
---------------------------------------------------------------*/

// Dependencies
var async = require('async');
var _ = require('underscore');
_.str = require('underscore.string');
var mysql = require('mysql');

module.exports = function () {

	// Keep track of all the dbs used by the app
	var dbs = {};

	var adapter = {

		// Enable dev-only commit log for now (in the future, native transaction support will be added)
		commitLog: {
			identity: '__default_waterline_mysql_transaction',
			adapter: 'waterline-dirty'
		},

		defaults: {

			// Pooling doesn't work yet, so it's off by default
			pool: false
		},

		escape: function (val) {
			return mysql.escape(val);
		},	

		// Direct access to query
		query: function (query, data, cb) {
			if (_.isFunction(data)) {
				cb = data;
				data = null;
			}
			spawnConnection(function (connection, cb) {
				
				// Run query
				if (data) connection.query(query, data, cb);
				else connection.query(query, cb);

			}, cb);
		},

		// Initialize the underlying data model
		registerCollection: function(collection, cb) {
			var self = this;

			
			// If the configuration in this collection corresponds 
			// with a known database, reuse it the connection(s) to that db
			dbs[collection.identity] = _.find(dbs, function (db) {
				return	collection.host === db.host &&
						collection.database === db.database;
			});

			// Otherwise initialize for the first time
			if ( !dbs[collection.identity] ) {

				dbs[collection.identity] = marshalConfig(collection);

				// Create the connection pool (if configured to do so)
				// TODO: make this actually work
				if (collection.pool) {
					this.pool = mysql.createPool(marshalConfig(collection));

					// Always make sure to keep a single connection tethered
					// to prevent shutdowns due to not having any live connections 
					// (hopefully this will be resolved in a subsequent release of node-mysql)
					this.pool.getConnection(function (err, connection) {
						self.tether = connection;
						cb();
					});
				}
				else return cb();
			}

		},

		teardown: function(cb) {
			var my = this;

			if (adapter.defaults.pool) {
				// TODO: Drain pool
			}

			cb && cb();
		},


		// Fetch the schema for a collection
		// (contains attributes and autoIncrement value)
		describe: function(collectionName, cb) {
			var self = this;
			spawnConnection(function __DESCRIBE__(connection, cb) {
				var tableName = mysql.escapeId(collectionName);
				var query = 'DESCRIBE ' + tableName;
				connection.query(query, function __DESCRIBE__(err, result) {
					if(err) {
						if(err.code === 'ER_NO_SUCH_TABLE') {
							result = null;
						} else return cb(err);
					}

					// TODO: check that what was returned actually matches the cache
					cb(null, result && self.schema[collectionName]);
				});
			}, dbs[collectionName], cb);
		},

		// Create a new collection
		define: function(collectionName, definition, cb) {
			spawnConnection(function __DEFINE__(connection, cb) {

				// Escape table name
				collectionName = mysql.escapeId(collectionName);

				// Iterate through each attribute, building a query string
				var $schema = sql.schema(collectionName, definition.attributes);

				// Build query
				var query = 'CREATE TABLE ' + collectionName + ' (' + $schema + ')';

				// Run query
				connection.query(query, function __DEFINE__(err, result) {
					if(err) return cb(err);
					cb(null, result);
				});
			}, dbs[collectionName], cb);
		},

		// Drop an existing collection
		drop: function(collectionName, cb) {
			spawnConnection(function __DROP__(connection, cb) {

				// Escape table name
				collectionName = mysql.escapeId(collectionName);

				// Build query
				var query = 'DROP TABLE ' + collectionName;

				// Run query
				connection.query(query, function __DROP__(err, result) {
					if(err) {
						if(err.code === 'ER_BAD_TABLE_ERROR') {
							result = null;
						} else return cb(err);
					}
					cb(null, result);
				});
			}, dbs[collectionName], cb);
		},

		// No custom alter necessary-- alter can be performed by using the other methods
		// you probably want to use the default in waterline core since this can get complex
		// (that is unless you want some enhanced functionality-- then please be our guest!)
		// Create one or more new models in the collection
		create: function(collectionName, data, cb) {
			spawnConnection(function(connection, cb) {


				// Escape table name
				var tableName = mysql.escapeId(collectionName);


				// Build query
				var query = 'INSERT INTO ' + tableName + ' ' + '(' + sql.attributes(collectionName, data) + ')' + ' VALUES (' + sql.values(collectionName, data) + ')';

				// Run query
				connection.query(query, function(err, result) {
					
					if(err) return cb(err);

					// Build model to return
					var model = _.extend({}, data, {

						// TODO: look up the autoIncrement attribute and increment that instead of assuming `id`
						id: result.insertId
					});

					cb(err, model);
				});
			}, dbs[collectionName], cb);
		},

		// Find one or more models from the collection
		// using where, limit, skip, and order
		// In where: handle `or`, `and`, and `like` queries
		find: function(collectionName, options, cb) {
			spawnConnection(function(connection, cb) {

				// Escape table name
				var tableName = mysql.escapeId(collectionName);

				// Build query
				var query = 'SELECT * FROM ' + tableName + ' ';

				query += sql.serializeOptions(collectionName, options);
				
				// Run query
				connection.query(query, function(err, result) {
					cb(err, result);
				});
			}, dbs[collectionName], cb);
		},

		// Update one or more models in the collection
		update: function(collectionName, options, values, cb) {
			spawnConnection(function(connection, cb) {

				// Escape table name
				var tableName = mysql.escapeId(collectionName);

				// Build query
				var query = 'UPDATE ' + tableName + ' SET ' + sql.criteria(collectionName, values) + ' ';

				query += sql.serializeOptions(collectionName, options);

				// Run query
				connection.query(query, function(err, result) {
					cb(err, result);
				});
			}, dbs[collectionName], cb);
		},

		// Delete one or more models from the collection
		destroy: function(collectionName, options, cb) {
			spawnConnection(function(connection, cb) {

				// Escape table name
				var tableName = mysql.escapeId(collectionName);

				// Build query
				var query = 'DELETE FROM ' + tableName + ' ';

				query += sql.serializeOptions(collectionName, options);

				// Run query
				connection.query(query, function(err, result) {
					cb(err, result);
				});
			}, dbs[collectionName], cb);
		},


		// Identity is here to facilitate unit testing
		// (this is optional and normally automatically populated based on filename)
		identity: 'waterline-mysql'
	};



	//////////////                 //////////////////////////////////////////
	////////////// Private Methods //////////////////////////////////////////
	//////////////                 //////////////////////////////////////////
	var sql = {
		// Create a schema csv for a DDL query
		schema: function(collectionName, attributes) {
			return sql.build(collectionName, attributes, sql._schema);
		},
		_schema: function(collectionName, attribute, attrName) {
			attrName = mysql.escapeId(attrName);
			var type = sqlTypeCast(attribute.type);
			return attrName + ' ' + type + ' ' + (attribute.autoIncrement ? 'NOT NULL AUTO_INCREMENT, ' + 'PRIMARY KEY(' + attrName + ')' : '');
		},

		// Create an attribute csv for a DQL query
		attributes: function(collectionName, attributes) {
			return sql.build(collectionName, attributes, sql.prepareAttribute);
		},

		// Create a value csv for a DQL query
		// key => optional, overrides the keys in the dictionary
		values: function(collectionName, values, key) {
			return sql.build(collectionName, values, sql.prepareValue, ', ', key);
		},

		// Create a WHERE criteria snippet for a DQL query
		criteria: function(collectionName, values) {
			return sql.build(collectionName, values, sql.prepareCriterion);
		},

		prepareCriterion: function(collectionName, value, key, parentKey) {
			// Special sub-attr case
			if (validSubAttrCriteria(value)) {
				return sql.where(collectionName, value, null, key);

			}
			
			// Build escaped attr and value strings using either the key,
			// or if one exists, the parent key
			var attrStr, valueStr;


			// Special comparator case
			if (parentKey) {

				attrStr = sql.prepareAttribute(collectionName, value, parentKey);
				valueStr = sql.prepareValue(collectionName, value, parentKey);

				if (key === '<' || key === 'lessThan') return attrStr + '<' + valueStr;
				else if (key === '<=' || key === 'lessThanOrEqual') return attrStr + '<=' + valueStr;
				else if (key === '>' || key === 'greaterThan') return attrStr + '>' + valueStr;
				else if (key === '>=' || key === 'greaterThanOrEqual') return attrStr + '>=' + valueStr;
				else if (key === '!' || key === 'not') {
					if (value === null) return attrStr + 'IS NOT NULL';
					else return attrStr + '<>' + valueStr;
				}
				else if (key === 'contains') return attrStr + ' LIKE %' + valueStr + '%';
				else if (key === 'startsWith') return attrStr + ' LIKE ' + valueStr + '%';
				else if (key === 'endsWith') return attrStr + ' LIKE %' + valueStr;
				else throw new Error ('Unknown comparator: ' + key);
			}
			else {
				attrStr = sql.prepareAttribute(collectionName, value, key);
				valueStr = sql.prepareValue(collectionName, value, key);

				// Special IS NULL case
				if(_.isNull(value)) {
					return attrStr + " IS NULL";
				} 
				else return attrStr + "=" + valueStr;
			}
		},

		prepareValue: function(collectionName, value, attrName) {

			// Cast dates to SQL
			if(_.isDate(value)) {
				value = toSqlDate(value);
			}

			// Cast functions to strings
			if (_.isFunction(value)) {
				value = value.toString();
			}

			// Escape (also wraps in quotes)
			return mysql.escape(value);
		},

		prepareAttribute: function(collectionName, value, attrName) {
			return mysql.escapeId(attrName);
		},

		// Starting point for predicate evaluation
		// parentKey => if set, look for comparators and apply them to the parent key
		where: function(collectionName, where, key, parentKey) {
			return sql.build(collectionName, where, sql.predicate, ' AND ', undefined, parentKey);
		},

		// Recursively parse a predicate calculus and build a SQL query
		predicate: function(collectionName, criterion, key, parentKey) {
			var queryPart = '';

			
			if (parentKey) {
				return sql.prepareCriterion(collectionName, criterion, key, parentKey);
			}

			// OR
			if(key.toLowerCase() === 'or') {
				queryPart = sql.build(collectionName, criterion, sql.where, ' OR ');
				return ' ( ' + queryPart + ' ) ';
			}

			// AND
			else if(key.toLowerCase() === 'and') {
				queryPart = sql.build(collectionName, criterion, sql.where, ' AND ');
				return ' ( ' + queryPart + ' ) ';
			}

			// IN
			else if(_.isArray(criterion)) {
				queryPart = sql.prepareAttribute(collectionName, null, key) + " IN (" + sql.values(collectionName, criterion, key) + ")";
				return queryPart;
			}

			// LIKE
			else if(key.toLowerCase() === 'like') {
				return sql.build(collectionName, criterion, function(collectionName, value, attrName) {
					var attrStr = sql.prepareAttribute(collectionName, value, attrName);

					
					// TODO: Handle regexp criterias
					if (_.isRegExp(value)) {
						throw new Error('RegExp LIKE criterias not supported by the MySQLAdapter yet.  Please contribute @ http://github.com/balderdashy/waterline-mysql');
					}
					
					var valueStr = sql.prepareValue(collectionName, value, attrName);

					// Handle escaped percent (%) signs [encoded as %%%]
					valueStr = valueStr.replace(/%%%/g, '\\%');

					return attrStr + " LIKE " + valueStr;
				}, ' AND ');
			}

			// NOT
			else if(key.toLowerCase() === 'not') {
				throw new Error('NOT not supported yet!');
			}

			// Basic criteria item
			else {
				return sql.prepareCriterion(collectionName, criterion, key);
			}

		},

		serializeOptions: function(collectionName, options) {
			var queryPart = '';

			if(options.where) {
				queryPart += 'WHERE ' + sql.where(collectionName, options.where) + ' ';
			}

			if(options.sort) {
				queryPart += 'ORDER BY ';

				// Sort through each sort attribute criteria
				_.each(options.sort, function(direction, attrName) {

					queryPart += sql.prepareAttribute(collectionName, null, attrName) + ' ';

					// Basic MongoDB-style numeric sort direction
					if(direction === 1) {
						queryPart += 'ASC ';
					} else {
						queryPart += 'DESC ';
					}
				});
			}

			if(options.limit) {
				queryPart += 'LIMIT ' + options.limit + ' ';
			} else {
				// Some MySQL hackery here.  For details, see: 
				// http://stackoverflow.com/questions/255517/mysql-offset-infinite-rows
				queryPart += 'LIMIT 18446744073709551610 ';
			}

			if(options.skip) {
				queryPart += 'OFFSET ' + options.skip + ' ';
			}
			
			return queryPart;
		},

		// Put together the CSV aggregation
		// separator => optional, defaults to ', '
		// keyOverride => optional, overrides the keys in the dictionary 
		//					(used for generating value lists in IN queries)
		// parentKey => key of the parent to this object
		build: function(collectionName, collection, fn, separator, keyOverride, parentKey) {
			separator = separator || ', ';
			var $sql = '';
			_.each(collection, function(value, key) {
				$sql += fn(collectionName, value, keyOverride || key, parentKey);

				// (always append separator)
				$sql += separator;
			});

			// (then remove final one)
			return _.str.rtrim($sql, separator);
		}
	};

	function wrapInQuotes(val) {
		return '"' + val + '"';
	}

	function toSqlDate(date) {
		return [[date.getFullYear(), ((date.getMonth() < 9 ? '0' : '') + (date.getMonth() + 1)), ((date.getDate() < 10 ? '0' : '') + date.getDate())].join("-"), date.toLocaleTimeString()].join(" ");
	}


	// Wrap a function in the logic necessary to provision a connection
	// (either grab a free connection from the pool or create a new one)
	function spawnConnection(logic, config, cb) {


		// Use a new connection each time
		if( !adapter.defaults.pool ) {
			var connection = mysql.createConnection(marshalConfig(config));
			connection.connect(function (err) {
				afterwards(err,connection);
			});
		}

		// Use connection pooling (using the new stuff from the `pool` branch in felixge's node-mysql)
		// (off by default)
		else {
			// TODO: make this actually work
			adapter.pool.getConnection(afterwards);
		}

		// Run logic using connection, then release/close it
		function afterwards(err, connection) {
			if(err) return cb(err);
			logic(connection, function(err, result) {
				connection.end(function () {
					cb(err, result);
				});
			});
		}
	}

	// Convert standard adapter config 
	// into a custom configuration object for node-mysql
	function marshalConfig (config) {
		return _.extend(config, {
			host	: config.host,
			user	: config.user,
			password: config.password,
			database: config.database
		});
	}

	// Cast waterline types into SQL data types
	function sqlTypeCast(type) {
		type = type.toLowerCase();

		switch(type) {
		case 'string':
			return 'TEXT';

		case 'int':
		case 'integer':
			return 'INT';

		case 'float':
		case 'double':
			return 'FLOAT';

		case 'date':
			return 'DATE';
		}
	}

	// Return whether this criteria is valid as an object inside of an attribute
	function validSubAttrCriteria (c) {
		return _.isObject(c) && (
			c.not || c.greaterThan || c.lessThan || 
			c.greaterThanOrEqual || c.lessThanOrEqual ||
			c['<'] || c['<='] || c['!'] || c['>'] || c['>='] ||
			c.startsWith || c.endsWith || c.contains
		);
	}

	return adapter;
};
