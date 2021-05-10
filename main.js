// For help writing plugins, visit the documentation to get started:
//   https://support.insomnia.rest/article/26-plugins

// TODO: Add plugin code here...
const jq = require('jsonpath');
const iconv = require('iconv-lite');
const {
	query: queryXPath
} = require('insomnia-xpath');

module.exports.templateTags = [{
	name: 'reponse',
	displayName: 'Response Enhance',
	description: "enhance insomnia origin response",
	args: [{
		displayName: 'Attribute',
		type: 'enum',
		options: [{
			displayName: 'Body Attribute',
			description: 'value of response body',
			value: 'body',
		},
		{
			displayName: 'Raw Body',
			description: 'entire response body',
			value: 'raw',
		},
		{
			displayName: 'Header',
			description: 'value of response header',
			value: 'header',
		},
		],
	},
	{
		displayName: 'Request',
		type: 'model',
		model: 'Request',
	},
	{
		type: 'string',
		hide: args => args[0].value === 'raw',
		displayName: args => {
			switch (args[0].value) {
				case 'body':
					return 'Filter (JSONPath or XPath)';
				case 'header':
					return 'Header Name';
				default:
					return 'Filter';
			}
		},
	},
	{
		displayName: 'functionName',
		type: 'enum',
		options: [{
			displayName: 'none',
			description: 'none of anything',
			value: 'NONE',
		}, {
			displayName: 'substring',
			description: 'substring with body',
			value: 'SUB_STRING',
		}],
	},
	{
		type: 'string',
		hide: args => args[3].value === 'NONE',
		displayName: args => {
			switch (args[3].value) {
				case 'NONE':
					return 'none';
				case 'SUB_STRING':
					return 'function params input like:startIndex,endIndex';
				default:
					return 'INVALID DATA';
			}
		},
	}
	],
	/**
	 * @param {Object} context 上下文
	 * @param {Object} field 
	 * @param {Object} id 请求ID
	 * @param {Object} filter xpath或者是json的表达式
	 * @param {Object} functionName 增强的方法名字
	 * @param {Object} functionParams 增强的方法的参数
	 */
	async run(context, field, id, filter, functionName, functionParams) {
		filter = filter || '';

		if (!['body', 'header', 'raw'].includes(field)) {
			throw new Error(`Invalid response field ${field}`);
		}

		if (!id) {
			throw new Error('No request specified');
		}

		const request = await context.util.models.request.getById(id);
		if (!request) {
			throw new Error(`Could not find request ${id}`);
		}

		const response = await context.util.models.response.getLatestForRequestId(id);

		if (!response) {
			throw new Error('No responses for request');
		}

		if (!response.statusCode) {
			throw new Error('No successful responses for request');
		}

		if (field !== 'raw' && !filter) {
			throw new Error(`No ${field} filter specified`);
		}

		const sanitizedFilter = filter.trim();

		if (field === 'header') {
			return matchHeader(response.headers, sanitizedFilter);
		} else if (field === 'raw') {
			const bodyBuffer = context.util.models.response.getBodyBuffer(response, '');
			const match = response.contentType.match(/charset=([\w-]+)/);
			const charset = match && match.length >= 2 ? match[1] : 'utf-8';

			// Sometimes iconv conversion fails so fallback to regular buffer
			try {
				return iconv.decode(bodyBuffer, charset);
			} catch (err) {
				console.warn('[response] Failed to decode body', err);
				return bodyBuffer.toString();
			}
		} else if (field === 'body') {
			const bodyBuffer = context.util.models.response.getBodyBuffer(response, '');
			const match = response.contentType.match(/charset=([\w-]+)/);
			const charset = match && match.length >= 2 ? match[1] : 'utf-8';

			// Sometimes iconv conversion fails so fallback to regular buffer
			let body;
			try {
				body = iconv.decode(bodyBuffer, charset);
			} catch (err) {
				body = bodyBuffer.toString();
				console.warn('[response] Failed to decode body', err);
			}

			let bodyResult;
			if (sanitizedFilter.indexOf('$') === 0) {
				bodyResult = matchJSONPath(body, sanitizedFilter);
			} else {
				bodyResult = matchXPath(body, sanitizedFilter)
			}
			return processCustomFunction(bodyResult, functionName, functionParams);
		} else {
			throw new Error(`Unknown field ${field}`);
		}
	},
},];

/**
 * 处理自定义行数
 * @param {*} data 类型
 * @param {*} functionName 行数名字 
 * @param {*} functionParams 函数参数字符串
 * @returns 
 */
function processCustomFunction(data, functionName, functionParams) {
	if (functionName === 'NONE') {
		return data;
	}
	if (typeof data !== 'string') {
		return data;
	}

	if (functionName === 'SUB_STRING') {
		if (functionParams === '') {
			return data;
		} else {
			try {
				const splitFlagIndex = functionParams.trim().indexOf(",");
				const startIndex = parseInt(functionParams.substr(0, splitFlagIndex).trim());
				const endIndex = parseInt(functionParams.substr(splitFlagIndex + 1).trim());

				debugger
				if (typeof startIndex === 'number' && typeof endIndex === 'number' && startIndex < endIndex) {
					return data.substring(startIndex, endIndex);
				}
				throw new Error('input function params must be notice:\n'
					+ 'format :startIndex,endIndex\n'
					+ 'condition: startIndex < endIndex \n');
			} catch (e) {
				return e.message;
			}
		}
	}


}

function matchJSONPath(bodyStr, query) {
	let body;
	let results;

	try {
		body = JSON.parse(bodyStr);
	} catch (err) {
		throw new Error(`Invalid JSON: ${err.message}`);
	}

	try {
		results = jq.query(body, query);
	} catch (err) {
		throw new Error(`Invalid JSONPath query: ${query}`);
	}

	if (results.length === 0) {
		throw new Error(`Returned no results: ${query}`);
	} else if (results.length > 1) {
		throw new Error(`Returned more than one result: ${query}`);
	}

	if (typeof results[0] !== 'string') {
		return JSON.stringify(results[0]);
	} else {
		return results[0];
	}
}

function matchXPath(bodyStr, query) {
	const results = queryXPath(bodyStr, query);

	if (results.length === 0) {
		throw new Error(`Returned no results: ${query}`);
	} else if (results.length > 1) {
		throw new Error(`Returned more than one result: ${query}`);
	}

	return results[0].inner;
}

function matchHeader(headers, name) {
	if (!headers.length) {
		throw new Error(`No headers available`);
	}

	const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());

	if (!header) {
		const names = headers.map(c => `"${c.name}"`).join(',\n\t');
		throw new Error(`No header with name "${name}".\nChoices are [\n\t${names}\n]`);
	}

	return header.value;
}
