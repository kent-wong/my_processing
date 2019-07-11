/**
 * Processing代码解析、转换核心函数
 * 将类Java代码转换为Javascript代码，以便于在浏览器中执行
 * 英文说明：
	Parser converts Java-like syntax into JavaScript.
    Creates an Abstract Syntax Tree -- "Light AST" from the Java-like code.

    It is an object tree. The root object is created from the AstRoot class, which contains statements.

    A statement object can be of type: AstForStatement, AstCatchStatement, AstPrefixStatement, AstMethod, AstClass, AstInterface, AstFunction, AstStatementBlock and AstLabel.

    AstPrefixStatement can be a statement of type: if, switch, while, with, do, else, finally, return, throw, try, break, and continue.

    These object's toString function returns the JavaScript code for the statement.

    Any processing calls need "processing." prepended to them.

    Similarly, calls from inside classes need "$this_1.", prepended to them,
    with 1 being the depth level for inner classes.
    This includes members passed down from inheritance.

    The resulting code is then eval'd and run.
 */
module.exports = function parseProcessing(code, options) {
	const defaultScope = options.defaultScope;
	const globalMembers = getGlobalMembers(options.aFunctions);

	// wk_debug
	console.log('debug(globalMembers):', globalMembers);
	console.log('debug(options):', options);
	console.log('debug(code):', code);


	// replaces strings and regexs keyed by index with an array of strings
	function injectStrings(code, strings) {
		return code.replace(/'(\d+)'/g, function(all, index) {
			var val = strings[index];
			if(val.charAt(0) === "/") {
				return val;
			}
			return (/^'((?:[^'\\\n])|(?:\\.[0-9A-Fa-f]*))'$/).test(val) ? "(new $p.Character(" + val + "))" : val;
		});
	}

	// trims off leading and trailing spaces
	// returns an object. object.left, object.middle, object.right, object.untrim
	function trimSpaces(string) {
		var m1 = /^\s*/.exec(string), result;
		if(m1[0].length === string.length) {
			result = {left: m1[0], middle: "", right: ""};
		} else {
			var m2 = /\s*$/.exec(string);
			result = {left: m1[0], middle: string.substring(m1[0].length, m2.index), right: m2[0]};
		}
		result.untrim = function(t) { return this.left + t + this.right; };
		return result;
	}

	// simple trim of leading and trailing spaces
	function trim(string) {
		return string.replace(/^\s+/,'').replace(/\s+$/,'');
	}

	function appendToLookupTable(table, array) {
		for(var i=0,l=array.length;i<l;++i) {
			table[array[i]] = null;
		}
		return table;
	}

	function isLookupTableEmpty(table) {
		for(var i in table) {
			if(table.hasOwnProperty(i)) {
				return false;
			}
		}
		return true;
	}

	function getAtomIndex(templ) { return templ.substring(2, templ.length - 1); }

	// remove carriage returns "\r"
	var codeWoExtraCr = code.replace(/\r\n?|\n\r/g, "\n");

	// masks strings and regexs with "'5'", where 5 is the index in an array containing all strings and regexs
	// also removes all comments
	var strings = [];
	var codeWoStrings = codeWoExtraCr.replace(/("(?:[^"\\\n]|\\.)*")|('(?:[^'\\\n]|\\.)*')|(([\[\(=|&!\^:?]\s*)(\/(?![*\/])(?:[^\/\\\n]|\\.)*\/[gim]*)\b)|(\/\/[^\n]*\n)|(\/\*(?:(?!\*\/)(?:.|\n))*\*\/)/g,
		function(all, quoted, aposed, regexCtx, prefix, regex, singleComment, comment) {
			var index;
			if(quoted || aposed) { // replace strings
				index = strings.length; strings.push(all);
				return "'" + index + "'";
			}
			if(regexCtx) { // replace RegExps
				index = strings.length; strings.push(regex);
				return prefix + "'" + index + "'";
			}
			// kill comments
			return comment !== "" ? " " : "\n";
		});

	// protect character codes from namespace collision
	codeWoStrings = codeWoStrings.replace(/__x([0-9A-F]{4})/g, function(all, hexCode) {
		// $ = __x0024
		// _ = __x005F
		// this protects existing character codes from conversion
		// __x0024 = __x005F_x0024
		return "__x005F_x" + hexCode;
	});

	// convert dollar sign to character code
	codeWoStrings = codeWoStrings.replace(/\$/g, "__x0024");

	// Remove newlines after return statements
	codeWoStrings = codeWoStrings.replace(/return\s*[\n\r]+/g, "return ");

	// removes generics
	var genericsWereRemoved;
	var codeWoGenerics = codeWoStrings;
	var replaceFunc = function(all, before, types, after) {
		if(!!before || !!after) {
			return all;
		}
		genericsWereRemoved = true;
		return "";
	};

	do {
		genericsWereRemoved = false;
		codeWoGenerics = codeWoGenerics.replace(/([<]?)<\s*((?:\?|[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)(?:\[\])*(?:\s+(?:extends|super)\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)?(?:\s*,\s*(?:\?|[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)(?:\[\])*(?:\s+(?:extends|super)\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)?)*)\s*>([=]?)/g, replaceFunc);
	} while (genericsWereRemoved);

	var atoms = splitToAtoms(codeWoGenerics);
	var replaceContext;
	var declaredClasses = {}, currentClassId, classIdSeed = 0;

	function addAtom(text, type) {
		var lastIndex = atoms.length;
		atoms.push(text);
		return '"' + type + lastIndex + '"';
	}

	function generateClassId() {
		return "class" + (++classIdSeed);
	}

	function appendClass(class_, classId, scopeId) {
		class_.classId = classId;
		class_.scopeId = scopeId;
		declaredClasses[classId] = class_;
	}

	// functions defined below
	var transformClassBody, transformInterfaceBody, transformStatementsBlock, transformStatements, transformMain, transformExpression;

	var classesRegex = /\b((?:(?:public|private|final|protected|static|abstract)\s+)*)(class|interface)\s+([A-Za-z_$][\w$]*\b)(\s+extends\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*,\s*[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*\b)*)?(\s+implements\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*,\s*[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*\b)*)?\s*("A\d+")/g;
	var methodsRegex = /\b((?:(?:public|private|final|protected|static|abstract|synchronized)\s+)*)((?!(?:else|new|return|throw|function|public|private|protected)\b)[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*"C\d+")*)\s*([A-Za-z_$][\w$]*\b)\s*("B\d+")(\s*throws\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*,\s*[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)*)?\s*("A\d+"|;)/g;
	var fieldTest = /^((?:(?:public|private|final|protected|static)\s+)*)((?!(?:else|new|return|throw)\b)[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*"C\d+")*)\s*([A-Za-z_$][\w$]*\b)\s*(?:"C\d+"\s*)*([=,]|$)/;
	var cstrsRegex = /\b((?:(?:public|private|final|protected|static|abstract)\s+)*)((?!(?:new|return|throw)\b)[A-Za-z_$][\w$]*\b)\s*("B\d+")(\s*throws\s+[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*,\s*[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)*)?\s*("A\d+")/g;
	var attrAndTypeRegex = /^((?:(?:public|private|final|protected|static)\s+)*)((?!(?:new|return|throw)\b)[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*(?:\s*"C\d+")*)\s*/;
	var functionsRegex = /\bfunction(?:\s+([A-Za-z_$][\w$]*))?\s*("B\d+")\s*("A\d+")/g;

	// This converts classes, methods and functions into atoms, and adds them to the atoms array.
	// classes = E, methods = D and functions = H
	function extractClassesAndMethods(code) {
		var s = code;
		s = s.replace(classesRegex, function(all) {
			return addAtom(all, 'E');
		});
		s = s.replace(methodsRegex, function(all) {
			return addAtom(all, 'D');
		});
		s = s.replace(functionsRegex, function(all) {
			return addAtom(all, 'H');
		});
		return s;
	}

	// This converts constructors into atoms, and adds them to the atoms array.
	// constructors = G
	function extractConstructors(code, className) {
		var result = code.replace(cstrsRegex, function(all, attr, name, params, throws_, body) {
			if(name !== className) {
				return all;
			}
			return addAtom(all, 'G');
		});
		return result;
	}

	// AstParam contains the name of a parameter inside a function declaration
	function AstParam(name) {
		this.name = name;
	}
	AstParam.prototype.toString = function() {
		return this.name;
	};
	// AstParams contains an array of AstParam objects
	function AstParams(params, methodArgsParam) {
		this.params = params;
		this.methodArgsParam = methodArgsParam;
	}
	AstParams.prototype.getNames = function() {
		var names = [];
		for(var i=0,l=this.params.length;i<l;++i) {
			names.push(this.params[i].name);
		}
		return names;
	};
	AstParams.prototype.prependMethodArgs = function(body) {
		if (!this.methodArgsParam) {
			return body;
		}
		return "{\nvar " + this.methodArgsParam.name +
			" = Array.prototype.slice.call(arguments, " +
			this.params.length + ");\n" + body.substring(1);
	};
	AstParams.prototype.toString = function() {
		if(this.params.length === 0) {
			return "()";
		}
		var result = "(";
		for(var i=0,l=this.params.length;i<l;++i) {
			result += this.params[i] + ", ";
		}
		return result.substring(0, result.length - 2) + ")";
	};

	function transformParams(params) {
		var paramsWoPars = trim(params.substring(1, params.length - 1));
		var result = [], methodArgsParam = null;
		if(paramsWoPars !== "") {
			var paramList = paramsWoPars.split(",");
			for(var i=0; i < paramList.length; ++i) {
				var param = /\b([A-Za-z_$][\w$]*\b)(\s*"[ABC][\d]*")*\s*$/.exec(paramList[i]);
				if (i === paramList.length - 1 && paramList[i].indexOf('...') >= 0) {
					methodArgsParam = new AstParam(param[1]);
					break;
				}
				result.push(new AstParam(param[1]));
			}
		}
		return new AstParams(result, methodArgsParam);
	}

	function preExpressionTransform(expr) {
		var s = expr;
		// new type[] {...} --> {...}
		s = s.replace(/\bnew\s+([A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)(?:\s*"C\d+")+\s*("A\d+")/g, function(all, type, init) {
			return init;
		});
		// new Runnable() {...} --> "F???"
		s = s.replace(/\bnew\s+([A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)(?:\s*"B\d+")\s*("A\d+")/g, function(all, type, init) {
			return addAtom(all, 'F');
		});
		// function(...) { } --> "H???"
		s = s.replace(functionsRegex, function(all) {
			return addAtom(all, 'H');
		});
		// new type[?] --> createJavaArray('type', [?])
		s = s.replace(/\bnew\s+([A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)\s*("C\d+"(?:\s*"C\d+")*)/g, function(all, type, index) {
			var args = index.replace(/"C(\d+)"/g, function(all, j) { return atoms[j]; })
				.replace(/\[\s*\]/g, "[null]").replace(/\s*\]\s*\[\s*/g, ", ");
			var arrayInitializer = "{" + args.substring(1, args.length - 1) + "}";
			var createArrayArgs = "('" + type + "', " + addAtom(arrayInitializer, 'A') + ")";
			return '$p.createJavaArray' + addAtom(createArrayArgs, 'B');
		});
		// .length() --> .length
		s = s.replace(/(\.\s*length)\s*"B\d+"/g, "$1");
		// #000000 --> 0x000000
		s = s.replace(/#([0-9A-Fa-f]{6})\b/g, function(all, digits) {
			return "0xFF" + digits;
		});
		// delete (type)???, except (int)???
		s = s.replace(/"B(\d+)"(\s*(?:[\w$']|"B))/g, function(all, index, next) {
			var atom = atoms[index];
			if(!/^\(\s*[A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*\s*(?:"C\d+"\s*)*\)$/.test(atom)) {
				return all;
			}
			if(/^\(\s*int\s*\)$/.test(atom)) {
				return "(int)" + next;
			}
			var indexParts = atom.split(/"C(\d+)"/g);
			if(indexParts.length > 1) {
				// even items contains atom numbers, can check only first
				if(! /^\[\s*\]$/.test(atoms[indexParts[1]])) {
					return all; // fallback - not a cast
				}
			}
			return "" + next;
		});
		// (int)??? -> __int_cast(???)
		s = s.replace(/\(int\)([^,\]\)\}\?\:\*\+\-\/\^\|\%\&\~<\>\=]+)/g, function(all, arg) {
			var trimmed = trimSpaces(arg);
			return trimmed.untrim("__int_cast(" + trimmed.middle + ")");
		});
		// super() -> $superCstr(), super. -> $super.;
		s = s.replace(/\bsuper(\s*"B\d+")/g, "$$superCstr$1").replace(/\bsuper(\s*\.)/g, "$$super$1");
		// 000.43->0.43 and 0010f->10, but not 0010
		s = s.replace(/\b0+((\d*)(?:\.[\d*])?(?:[eE][\-\+]?\d+)?[fF]?)\b/, function(all, numberWo0, intPart) {
			if( numberWo0 === intPart) {
				return all;
			}
			return intPart === "" ? "0" + numberWo0 : numberWo0;
		});
		// 3.0f -> 3.0
		s = s.replace(/\b(\.?\d+\.?)[fF]\b/g, "$1");
		// Weird (?) parsing errors with %
		s = s.replace(/([^\s])%([^=\s])/g, "$1 % $2");
		// Since frameRate() and frameRate are different things,
		// we need to differentiate them somehow. So when we parse
		// the Processing.js source, replace frameRate so it isn't
		// confused with frameRate(), as well as keyPressed and mousePressed
		s = s.replace(/\b(frameRate|keyPressed|mousePressed)\b(?!\s*"B)/g, "__$1");
		// "boolean", "byte", "int", etc. => "parseBoolean", "parseByte", "parseInt", etc.
		s = s.replace(/\b(boolean|byte|char|float|int)\s*"B/g, function(all, name) {
			return "parse" + name.substring(0, 1).toUpperCase() + name.substring(1) + "\"B";
		});
		// "pixels" replacements:
		//   pixels[i] = c => pixels.setPixel(i,c) | pixels[i] => pixels.getPixel(i)
		//   pixels.length => pixels.getLength()
		//   pixels = ar => pixels.set(ar) | pixels => pixels.toArray()
		s = s.replace(/\bpixels\b\s*(("C(\d+)")|\.length)?(\s*=(?!=)([^,\]\)\}]+))?/g,
			function(all, indexOrLength, index, atomIndex, equalsPart, rightSide) {
				if(index) {
					var atom = atoms[atomIndex];
					if(equalsPart) {
						return "pixels.setPixel" + addAtom("(" +atom.substring(1, atom.length - 1) +
							"," + rightSide + ")", 'B');
					}
					return "pixels.getPixel" + addAtom("(" + atom.substring(1, atom.length - 1) +
						")", 'B');
				}
				if(indexOrLength) {
					// length
					return "pixels.getLength" + addAtom("()", 'B');
				}
				if(equalsPart) {
					return "pixels.set" + addAtom("(" + rightSide + ")", 'B');
				}
				return "pixels.toArray" + addAtom("()", 'B');
			});
		// Java method replacements for: replace, replaceAll, replaceFirst, equals, hashCode, etc.
		//   xxx.replace(yyy) -> __replace(xxx, yyy)
		//   "xx".replace(yyy) -> __replace("xx", yyy)
		var repeatJavaReplacement;
		function replacePrototypeMethods(all, subject, method, atomIndex) {
			var atom = atoms[atomIndex];
			repeatJavaReplacement = true;
			var trimmed = trimSpaces(atom.substring(1, atom.length - 1));
			return "__" + method  + ( trimmed.middle === "" ? addAtom("(" + subject.replace(/\.\s*$/, "") + ")", 'B') :
				addAtom("(" + subject.replace(/\.\s*$/, "") + "," + trimmed.middle + ")", 'B') );
		}
		do {
			repeatJavaReplacement = false;
			s = s.replace(/((?:'\d+'|\b[A-Za-z_$][\w$]*\s*(?:"[BC]\d+")*)\s*\.\s*(?:[A-Za-z_$][\w$]*\s*(?:"[BC]\d+"\s*)*\.\s*)*)(replace|replaceAll|replaceFirst|contains|equals|equalsIgnoreCase|hashCode|toCharArray|printStackTrace|split|startsWith|endsWith|codePointAt|matches)\s*"B(\d+)"/g,
				replacePrototypeMethods);
		} while (repeatJavaReplacement);
		// xxx instanceof yyy -> __instanceof(xxx, yyy)
		function replaceInstanceof(all, subject, type) {
			repeatJavaReplacement = true;
			return "__instanceof" + addAtom("(" + subject + ", " + type + ")", 'B');
		}
		do {
			repeatJavaReplacement = false;
			s = s.replace(/((?:'\d+'|\b[A-Za-z_$][\w$]*\s*(?:"[BC]\d+")*)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*(?:"[BC]\d+"\s*)*)*)instanceof\s+([A-Za-z_$][\w$]*\s*(?:\.\s*[A-Za-z_$][\w$]*)*)/g,
				replaceInstanceof);
		} while (repeatJavaReplacement);
		// this() -> $constr()
		s = s.replace(/\bthis(\s*"B\d+")/g, "$$constr$1");

		return s;
	}

	function AstInlineClass(baseInterfaceName, body) {
		this.baseInterfaceName = baseInterfaceName;
		this.body = body;
		body.owner = this;
	}
	AstInlineClass.prototype.toString = function() {
		return "new (" + this.body + ")";
	};

	function transformInlineClass(class_) {
		var m = new RegExp(/\bnew\s*([A-Za-z_$][\w$]*\s*(?:\.\s*[A-Za-z_$][\w$]*)*)\s*"B\d+"\s*"A(\d+)"/).exec(class_);
		var oldClassId = currentClassId, newClassId = generateClassId();
		currentClassId = newClassId;
		var uniqueClassName = m[1] + "$" + newClassId;
		var inlineClass = new AstInlineClass(uniqueClassName,
			transformClassBody(atoms[m[2]], uniqueClassName, "", "implements " + m[1]));
		appendClass(inlineClass, newClassId, oldClassId);
		currentClassId = oldClassId;
		return inlineClass;
	}

	function AstFunction(name, params, body) {
		this.name = name;
		this.params = params;
		this.body = body;
	}
	AstFunction.prototype.toString = function() {
		var oldContext = replaceContext;
		// saving "this." and parameters
		var names = appendToLookupTable({"this":null}, this.params.getNames());
		replaceContext = function (subject) {
			return names.hasOwnProperty(subject.name) ? subject.name : oldContext(subject);
		};
		var result = "function";
		if(this.name) {
			result += " " + this.name;
		}
		var body = this.params.prependMethodArgs(this.body.toString());
		result += this.params + " " + body;
		replaceContext = oldContext;
		return result;
	};

	function transformFunction(class_) {
		var m = new RegExp(/\b([A-Za-z_$][\w$]*)\s*"B(\d+)"\s*"A(\d+)"/).exec(class_);
		return new AstFunction( m[1] !== "function" ? m[1] : null,
			transformParams(atoms[m[2]]), transformStatementsBlock(atoms[m[3]]));
	}

	function AstInlineObject(members) {
		this.members = members;
	}
	AstInlineObject.prototype.toString = function() {
		var oldContext = replaceContext;
		replaceContext = function (subject) {
			return subject.name === "this" ? "this" : oldContext(subject); // saving "this."
		};
		var result = "";
		for(var i=0,l=this.members.length;i<l;++i) {
			if(this.members[i].label) {
				result += this.members[i].label + ": ";
			}
			result += this.members[i].value.toString() + ", ";
		}
		replaceContext = oldContext;
		return result.substring(0, result.length - 2);
	};

	function transformInlineObject(obj) {
		var members = obj.split(',');
		for(var i=0; i < members.length; ++i) {
			var label = members[i].indexOf(':');
			if(label < 0) {
				members[i] = { value: transformExpression(members[i]) };
			} else {
				members[i] = { label: trim(members[i].substring(0, label)),
					value: transformExpression( trim(members[i].substring(label + 1)) ) };
			}
		}
		return new AstInlineObject(members);
	}

	function expandExpression(expr) {
		if(expr.charAt(0) === '(' || expr.charAt(0) === '[') {
			return expr.charAt(0) + expandExpression(expr.substring(1, expr.length - 1)) + expr.charAt(expr.length - 1);
		}
		if(expr.charAt(0) === '{') {
			if(/^\{\s*(?:[A-Za-z_$][\w$]*|'\d+')\s*:/.test(expr)) {
				return "{" + addAtom(expr.substring(1, expr.length - 1), 'I') + "}";
			}
			return "[" + expandExpression(expr.substring(1, expr.length - 1)) + "]";
		}
		var trimmed = trimSpaces(expr);
		var result = preExpressionTransform(trimmed.middle);
		result = result.replace(/"[ABC](\d+)"/g, function(all, index) {
			return expandExpression(atoms[index]);
		});
		return trimmed.untrim(result);
	}

	function replaceContextInVars(expr) {
		return expr.replace(/(\.\s*)?((?:\b[A-Za-z_]|\$)[\w$]*)(\s*\.\s*([A-Za-z_$][\w$]*)(\s*\()?)?/g,
			function(all, memberAccessSign, identifier, suffix, subMember, callSign) {
				if(memberAccessSign) {
					return all;
				}
				var subject = { name: identifier, member: subMember, callSign: !!callSign };
				return replaceContext(subject) + (suffix === undefined ? "" : suffix);
			});
	}

	function AstExpression(expr, transforms) {
		this.expr = expr;
		this.transforms = transforms;
	}
	AstExpression.prototype.toString = function() {
		var transforms = this.transforms;
		var expr = replaceContextInVars(this.expr);
		return expr.replace(/"!(\d+)"/g, function(all, index) {
			return transforms[index].toString();
		});
	};

	transformExpression = function(expr) {
		var transforms = [];
		var s = expandExpression(expr);
		s = s.replace(/"H(\d+)"/g, function(all, index) {
			transforms.push(transformFunction(atoms[index]));
			return '"!' + (transforms.length - 1) + '"';
		});
		s = s.replace(/"F(\d+)"/g, function(all, index) {
			transforms.push(transformInlineClass(atoms[index]));
			return '"!' + (transforms.length - 1) + '"';
		});
		s = s.replace(/"I(\d+)"/g, function(all, index) {
			transforms.push(transformInlineObject(atoms[index]));
			return '"!' + (transforms.length - 1) + '"';
		});

		return new AstExpression(s, transforms);
	};

	function AstVarDefinition(name, value, isDefault) {
		this.name = name;
		this.value = value;
		this.isDefault = isDefault;
	}
	AstVarDefinition.prototype.toString = function() {
		return this.name + ' = ' + this.value;
	};

	function transformVarDefinition(def, defaultTypeValue) {
		var eqIndex = def.indexOf("=");
		var name, value, isDefault;
		if(eqIndex < 0) {
			name = def;
			value = defaultTypeValue;
			isDefault = true;
		} else {
			name = def.substring(0, eqIndex);
			value = transformExpression(def.substring(eqIndex + 1));
			isDefault = false;
		}
		return new AstVarDefinition( trim(name.replace(/(\s*"C\d+")+/g, "")),
			value, isDefault);
	}

	function getDefaultValueForType(type) {
		if(type === "int" || type === "float") {
			return "0";
		}
		if(type === "boolean") {
			return "false";
		}
		if(type === "color") {
			return "0x00000000";
		}
		return "null";
	}

	function AstVar(definitions, varType) {
		this.definitions = definitions;
		this.varType = varType;
	}
	AstVar.prototype.getNames = function() {
		var names = [];
		for(var i=0,l=this.definitions.length;i<l;++i) {
			names.push(this.definitions[i].name);
		}
		return names;
	};
	AstVar.prototype.toString = function() {
		return "var " + this.definitions.join(",");
	};
	function AstStatement(expression) {
		this.expression = expression;
	}
	AstStatement.prototype.toString = function() {
		return this.expression.toString();
	};

	function transformStatement(statement) {
		if(fieldTest.test(statement)) {
			var attrAndType = attrAndTypeRegex.exec(statement);
			var definitions = statement.substring(attrAndType[0].length).split(",");
			var defaultTypeValue = getDefaultValueForType(attrAndType[2]);
			for(var i=0; i < definitions.length; ++i) {
				definitions[i] = transformVarDefinition(definitions[i], defaultTypeValue);
			}
			return new AstVar(definitions, attrAndType[2]);
		}
		return new AstStatement(transformExpression(statement));
	}

	function AstForExpression(initStatement, condition, step) {
		this.initStatement = initStatement;
		this.condition = condition;
		this.step = step;
	}
	AstForExpression.prototype.toString = function() {
		return "(" + this.initStatement + "; " + this.condition + "; " + this.step + ")";
	};

	function AstForInExpression(initStatement, container) {
		this.initStatement = initStatement;
		this.container = container;
	}
	AstForInExpression.prototype.toString = function() {
		var init = this.initStatement.toString();
		if(init.indexOf("=") >= 0) { // can be without var declaration
			init = init.substring(0, init.indexOf("="));
		}
		return "(" + init + " in " + this.container + ")";
	};

	function AstForEachExpression(initStatement, container) {
		this.initStatement = initStatement;
		this.container = container;
	}
	AstForEachExpression.iteratorId = 0;
	AstForEachExpression.prototype.toString = function() {
		var init = this.initStatement.toString();
		var iterator = "$it" + (AstForEachExpression.iteratorId++);
		var variableName = init.replace(/^\s*var\s*/, "").split("=")[0];
		var initIteratorAndVariable = "var " + iterator + " = new $p.ObjectIterator(" + this.container + "), " +
			variableName + " = void(0)";
		var nextIterationCondition = iterator + ".hasNext() && ((" +
			variableName + " = " + iterator + ".next()) || true)";
		return "(" + initIteratorAndVariable + "; " + nextIterationCondition + ";)";
	};

	function transformForExpression(expr) {
		var content;
		if (/\bin\b/.test(expr)) {
			content = expr.substring(1, expr.length - 1).split(/\bin\b/g);
			return new AstForInExpression( transformStatement(trim(content[0])),
				transformExpression(content[1]));
		}
		if (expr.indexOf(":") >= 0 && expr.indexOf(";") < 0) {
			content = expr.substring(1, expr.length - 1).split(":");
			return new AstForEachExpression( transformStatement(trim(content[0])),
				transformExpression(content[1]));
		}
		content = expr.substring(1, expr.length - 1).split(";");
		return new AstForExpression( transformStatement(trim(content[0])),
			transformExpression(content[1]), transformExpression(content[2]));
	}

	function sortByWeight(array) {
		array.sort(function (a,b) {
			return b.weight - a.weight;
		});
	}

	function AstInnerInterface(name, body, isStatic) {
		this.name = name;
		this.body = body;
		this.isStatic = isStatic;
		body.owner = this;
	}
	AstInnerInterface.prototype.toString = function() {
		return "" + this.body;
	};
	function AstInnerClass(name, body, isStatic) {
		this.name = name;
		this.body = body;
		this.isStatic = isStatic;
		body.owner = this;
	}
	AstInnerClass.prototype.toString = function() {
		return "" + this.body;
	};

	function transformInnerClass(class_) {
		var m = classesRegex.exec(class_); // 1 - attr, 2 - class|int, 3 - name, 4 - extends, 5 - implements, 6 - body
		classesRegex.lastIndex = 0;
		var isStatic = m[1].indexOf("static") >= 0;
		var body = atoms[getAtomIndex(m[6])], innerClass;
		var oldClassId = currentClassId, newClassId = generateClassId();
		currentClassId = newClassId;
		if(m[2] === "interface") {
			innerClass = new AstInnerInterface(m[3], transformInterfaceBody(body, m[3], m[4]), isStatic);
		} else {
			innerClass = new AstInnerClass(m[3], transformClassBody(body, m[3], m[4], m[5]), isStatic);
		}
		appendClass(innerClass, newClassId, oldClassId);
		currentClassId = oldClassId;
		return innerClass;
	}

	function AstClassMethod(name, params, body, isStatic) {
		this.name = name;
		this.params = params;
		this.body = body;
		this.isStatic = isStatic;
	}
	AstClassMethod.prototype.toString = function(){
		var paramNames = appendToLookupTable({}, this.params.getNames());
		var oldContext = replaceContext;
		replaceContext = function (subject) {
			return paramNames.hasOwnProperty(subject.name) ? subject.name : oldContext(subject);
		};
		var body = this.params.prependMethodArgs(this.body.toString());
		var result = "function " + this.methodId + this.params + " " + body +"\n";
		replaceContext = oldContext;
		return result;
	};

	function transformClassMethod(method) {
		var m = methodsRegex.exec(method);
		methodsRegex.lastIndex = 0;
		var isStatic = m[1].indexOf("static") >= 0;
		var body = m[6] !== ';' ? atoms[getAtomIndex(m[6])] : "{}";
		return new AstClassMethod(m[3], transformParams(atoms[getAtomIndex(m[4])]),
			transformStatementsBlock(body), isStatic );
	}

	function AstClassField(definitions, fieldType, isStatic) {
		this.definitions = definitions;
		this.fieldType = fieldType;
		this.isStatic = isStatic;
	}
	AstClassField.prototype.getNames = function() {
		var names = [];
		for(var i=0,l=this.definitions.length;i<l;++i) {
			names.push(this.definitions[i].name);
		}
		return names;
	};
	AstClassField.prototype.toString = function() {
		var thisPrefix = replaceContext({ name: "[this]" });
		if(this.isStatic) {
			var className = this.owner.name;
			var staticDeclarations = [];
			for(var i=0,l=this.definitions.length;i<l;++i) {
				var definition = this.definitions[i];
				var name = definition.name, staticName = className + "." + name;
				var declaration = "if(" + staticName + " === void(0)) {\n" +
					" " + staticName + " = " + definition.value + "; }\n" +
					"$p.defineProperty(" + thisPrefix + ", " +
					"'" + name + "', { get: function(){return " + staticName + ";}, " +
					"set: function(val){" + staticName + " = val;} });\n";
				staticDeclarations.push(declaration);
			}
			return staticDeclarations.join("");
		}
		return thisPrefix + "." + this.definitions.join("; " + thisPrefix + ".");
	};

	function transformClassField(statement) {
		var attrAndType = attrAndTypeRegex.exec(statement);
		var isStatic = attrAndType[1].indexOf("static") >= 0;
		var definitions = statement.substring(attrAndType[0].length).split(/,\s*/g);
		var defaultTypeValue = getDefaultValueForType(attrAndType[2]);
		for(var i=0; i < definitions.length; ++i) {
			definitions[i] = transformVarDefinition(definitions[i], defaultTypeValue);
		}
		return new AstClassField(definitions, attrAndType[2], isStatic);
	}

	function AstConstructor(params, body) {
		this.params = params;
		this.body = body;
	}
	AstConstructor.prototype.toString = function() {
		var paramNames = appendToLookupTable({}, this.params.getNames());
		var oldContext = replaceContext;
		replaceContext = function (subject) {
			return paramNames.hasOwnProperty(subject.name) ? subject.name : oldContext(subject);
		};
		var prefix = "function $constr_" + this.params.params.length + this.params.toString();
		var body = this.params.prependMethodArgs(this.body.toString());
		if(!/\$(superCstr|constr)\b/.test(body)) {
			body = "{\n$superCstr();\n" + body.substring(1);
		}
		replaceContext = oldContext;
		return prefix + body + "\n";
	};

	function transformConstructor(cstr) {
		var m = new RegExp(/"B(\d+)"\s*"A(\d+)"/).exec(cstr);
		var params = transformParams(atoms[m[1]]);

		return new AstConstructor(params, transformStatementsBlock(atoms[m[2]]));
	}

	function AstInterfaceBody(name, interfacesNames, methodsNames, fields, innerClasses, misc) {
		var i,l;
		this.name = name;
		this.interfacesNames = interfacesNames;
		this.methodsNames = methodsNames;
		this.fields = fields;
		this.innerClasses = innerClasses;
		this.misc = misc;
		for(i=0,l=fields.length; i<l; ++i) {
			fields[i].owner = this;
		}
	}
	AstInterfaceBody.prototype.getMembers = function(classFields, classMethods, classInners) {
		if(this.owner.base) {
			this.owner.base.body.getMembers(classFields, classMethods, classInners);
		}
		var i, j, l, m;
		for(i=0,l=this.fields.length;i<l;++i) {
			var fieldNames = this.fields[i].getNames();
			for(j=0,m=fieldNames.length;j<m;++j) {
				classFields[fieldNames[j]] = this.fields[i];
			}
		}
		for(i=0,l=this.methodsNames.length;i<l;++i) {
			var methodName = this.methodsNames[i];
			classMethods[methodName] = true;
		}
		for(i=0,l=this.innerClasses.length;i<l;++i) {
			var innerClass = this.innerClasses[i];
			classInners[innerClass.name] = innerClass;
		}
	};
	AstInterfaceBody.prototype.toString = function() {
		function getScopeLevel(p) {
			var i = 0;
			while(p) {
				++i;
				p=p.scope;
			}
			return i;
		}

		var scopeLevel = getScopeLevel(this.owner);

		var className = this.name;
		var staticDefinitions = "";
		var metadata = "";

		var thisClassFields = {}, thisClassMethods = {}, thisClassInners = {};
		this.getMembers(thisClassFields, thisClassMethods, thisClassInners);

		var i, l, j, m;

		if (this.owner.interfaces) {
			// interface name can be present, but interface is not
			var resolvedInterfaces = [], resolvedInterface;
			for (i = 0, l = this.interfacesNames.length; i < l; ++i) {
				if (!this.owner.interfaces[i]) {
					continue;
				}
				resolvedInterface = replaceContext({name: this.interfacesNames[i]});
				resolvedInterfaces.push(resolvedInterface);
				staticDefinitions += "$p.extendInterfaceMembers(" + className + ", " + resolvedInterface + ");\n";
			}
			metadata += className + ".$interfaces = [" + resolvedInterfaces.join(", ") + "];\n";
		}
		metadata += className + ".$isInterface = true;\n";
		metadata += className + ".$methods = [\'" + this.methodsNames.join("\', \'") + "\'];\n";

		sortByWeight(this.innerClasses);
		for (i = 0, l = this.innerClasses.length; i < l; ++i) {
			var innerClass = this.innerClasses[i];
			if (innerClass.isStatic) {
				staticDefinitions += className + "." + innerClass.name + " = " + innerClass + ";\n";
			}
		}

		for (i = 0, l = this.fields.length; i < l; ++i) {
			var field = this.fields[i];
			if (field.isStatic) {
				staticDefinitions += className + "." + field.definitions.join(";\n" + className + ".") + ";\n";
			}
		}

		return "(function() {\n" +
			"function " + className + "() { throw \'Unable to create the interface\'; }\n" +
			staticDefinitions +
			metadata +
			"return " + className + ";\n" +
			"})()";
	};

	transformInterfaceBody = function(body, name, baseInterfaces) {
		var declarations = body.substring(1, body.length - 1);
		declarations = extractClassesAndMethods(declarations);
		declarations = extractConstructors(declarations, name);
		var methodsNames = [], classes = [];
		declarations = declarations.replace(/"([DE])(\d+)"/g, function(all, type, index) {
			if(type === 'D') { methodsNames.push(index); }
			else if(type === 'E') { classes.push(index); }
			return "";
		});
		var fields = declarations.split(/;(?:\s*;)*/g);
		var baseInterfaceNames;
		var i, l;

		if(baseInterfaces !== undefined) {
			baseInterfaceNames = baseInterfaces.replace(/^\s*extends\s+(.+?)\s*$/g, "$1").split(/\s*,\s*/g);
		}

		for(i = 0, l = methodsNames.length; i < l; ++i) {
			var method = transformClassMethod(atoms[methodsNames[i]]);
			methodsNames[i] = method.name;
		}
		for(i = 0, l = fields.length - 1; i < l; ++i) {
			var field = trimSpaces(fields[i]);
			fields[i] = transformClassField(field.middle);
		}
		var tail = fields.pop();
		for(i = 0, l = classes.length; i < l; ++i) {
			classes[i] = transformInnerClass(atoms[classes[i]]);
		}

		return new AstInterfaceBody(name, baseInterfaceNames, methodsNames, fields, classes, { tail: tail });
	};

	function AstClassBody(name, baseClassName, interfacesNames, functions, methods, fields, cstrs, innerClasses, misc) {
		var i,l;
		this.name = name;
		this.baseClassName = baseClassName;
		this.interfacesNames = interfacesNames;
		this.functions = functions;
		this.methods = methods;
		this.fields = fields;
		this.cstrs = cstrs;
		this.innerClasses = innerClasses;
		this.misc = misc;
		for(i=0,l=fields.length; i<l; ++i) {
			fields[i].owner = this;
		}
	}
	AstClassBody.prototype.getMembers = function(classFields, classMethods, classInners) {
		if(this.owner.base) {
			this.owner.base.body.getMembers(classFields, classMethods, classInners);
		}
		var i, j, l, m;
		for(i=0,l=this.fields.length;i<l;++i) {
			var fieldNames = this.fields[i].getNames();
			for(j=0,m=fieldNames.length;j<m;++j) {
				classFields[fieldNames[j]] = this.fields[i];
			}
		}
		for(i=0,l=this.methods.length;i<l;++i) {
			var method = this.methods[i];
			classMethods[method.name] = method;
		}
		for(i=0,l=this.innerClasses.length;i<l;++i) {
			var innerClass = this.innerClasses[i];
			classInners[innerClass.name] = innerClass;
		}
	};
	AstClassBody.prototype.toString = function() {
		function getScopeLevel(p) {
			var i = 0;
			while(p) {
				++i;
				p=p.scope;
			}
			return i;
		}

		var scopeLevel = getScopeLevel(this.owner);

		var selfId = "$this_" + scopeLevel;
		var className = this.name;
		var result = "var " + selfId + " = this;\n";
		var staticDefinitions = "";
		var metadata = "";

		var thisClassFields = {}, thisClassMethods = {}, thisClassInners = {};
		this.getMembers(thisClassFields, thisClassMethods, thisClassInners);

		var oldContext = replaceContext;
		replaceContext = function (subject) {
			var name = subject.name;
			if(name === "this") {
				// returns "$this_N.$self" pointer instead of "this" in cases:
				// "this()", "this.XXX()", "this", but not for "this.XXX"
				return subject.callSign || !subject.member ? selfId + ".$self" : selfId;
			}
			if(thisClassFields.hasOwnProperty(name)) {
				return thisClassFields[name].isStatic ? className + "." + name : selfId + "." + name;
			}
			if(thisClassInners.hasOwnProperty(name)) {
				return selfId + "." + name;
			}
			if(thisClassMethods.hasOwnProperty(name)) {
				return thisClassMethods[name].isStatic ? className + "." + name : selfId + ".$self." + name;
			}
			return oldContext(subject);
		};

		var resolvedBaseClassName;
		if (this.baseClassName) {
			resolvedBaseClassName = oldContext({name: this.baseClassName});
			result += "var $super = { $upcast: " + selfId + " };\n";
			result += "function $superCstr(){" + resolvedBaseClassName +
				".apply($super,arguments);if(!('$self' in $super)) $p.extendClassChain($super)}\n";
			metadata += className + ".$base = " + resolvedBaseClassName + ";\n";
		} else {
			result += "function $superCstr(){$p.extendClassChain("+ selfId +")}\n";
		}

		if (this.owner.base) {
			// base class name can be present, but class is not
			staticDefinitions += "$p.extendStaticMembers(" + className + ", " + resolvedBaseClassName + ");\n";
		}

		var i, l, j, m;

		if (this.owner.interfaces) {
			// interface name can be present, but interface is not
			var resolvedInterfaces = [], resolvedInterface;
			for (i = 0, l = this.interfacesNames.length; i < l; ++i) {
				if (!this.owner.interfaces[i]) {
					continue;
				}
				resolvedInterface = oldContext({name: this.interfacesNames[i]});
				resolvedInterfaces.push(resolvedInterface);
				staticDefinitions += "$p.extendInterfaceMembers(" + className + ", " + resolvedInterface + ");\n";
			}
			metadata += className + ".$interfaces = [" + resolvedInterfaces.join(", ") + "];\n";
		}

		if (this.functions.length > 0) {
			result += this.functions.join('\n') + '\n';
		}

		sortByWeight(this.innerClasses);
		for (i = 0, l = this.innerClasses.length; i < l; ++i) {
			var innerClass = this.innerClasses[i];
			if (innerClass.isStatic) {
				staticDefinitions += className + "." + innerClass.name + " = " + innerClass + ";\n";
				result += selfId + "." + innerClass.name + " = " + className + "." + innerClass.name + ";\n";
			} else {
				result += selfId + "." + innerClass.name + " = " + innerClass + ";\n";
			}
		}

		for (i = 0, l = this.fields.length; i < l; ++i) {
			var field = this.fields[i];
			if (field.isStatic) {
				staticDefinitions += className + "." + field.definitions.join(";\n" + className + ".") + ";\n";
				for (j = 0, m = field.definitions.length; j < m; ++j) {
					var fieldName = field.definitions[j].name, staticName = className + "." + fieldName;
					result += "$p.defineProperty(" + selfId + ", '" + fieldName + "', {" +
						"get: function(){return " + staticName + "}, " +
						"set: function(val){" + staticName + " = val}});\n";
				}
			} else {
				result += selfId + "." + field.definitions.join(";\n" + selfId + ".") + ";\n";
			}
		}
		var methodOverloads = {};
		for (i = 0, l = this.methods.length; i < l; ++i) {
			var method = this.methods[i];
			var overload = methodOverloads[method.name];
			var methodId = method.name + "$" + method.params.params.length;
			var hasMethodArgs = !!method.params.methodArgsParam;
			if (overload) {
				++overload;
				methodId += "_" + overload;
			} else {
				overload = 1;
			}
			method.methodId = methodId;
			methodOverloads[method.name] = overload;
			if (method.isStatic) {
				staticDefinitions += method;
				staticDefinitions += "$p.addMethod(" + className + ", '" + method.name + "', " + methodId + ", " + hasMethodArgs + ");\n";
				result += "$p.addMethod(" + selfId + ", '" + method.name + "', " + methodId + ", " + hasMethodArgs + ");\n";
			} else {
				result += method;
				result += "$p.addMethod(" + selfId + ", '" + method.name + "', " + methodId + ", " + hasMethodArgs + ");\n";
			}
		}
		result += trim(this.misc.tail);

		if (this.cstrs.length > 0) {
			result += this.cstrs.join('\n') + '\n';
		}

		result += "function $constr() {\n";
		var cstrsIfs = [];
		for (i = 0, l = this.cstrs.length; i < l; ++i) {
			var paramsLength = this.cstrs[i].params.params.length;
			var methodArgsPresent = !!this.cstrs[i].params.methodArgsParam;
			cstrsIfs.push("if(arguments.length " + (methodArgsPresent ? ">=" : "===") +
				" " + paramsLength + ") { " +
					"$constr_" + paramsLength + ".apply(" + selfId + ", arguments); }");
		}
		if(cstrsIfs.length > 0) {
			result += cstrsIfs.join(" else ") + " else ";
		}
		// ??? add check if length is 0, otherwise fail
		result += "$superCstr();\n}\n";
		result += "$constr.apply(null, arguments);\n";

		replaceContext = oldContext;
		return "(function() {\n" +
			"function " + className + "() {\n" + result + "}\n" +
			staticDefinitions +
			metadata +
			"return " + className + ";\n" +
			"})()";
	};

	transformClassBody = function(body, name, baseName, interfaces) {
		var declarations = body.substring(1, body.length - 1);
		declarations = extractClassesAndMethods(declarations);
		declarations = extractConstructors(declarations, name);
		var methods = [], classes = [], cstrs = [], functions = [];
		declarations = declarations.replace(/"([DEGH])(\d+)"/g, function(all, type, index) {
			if(type === 'D') { methods.push(index); }
			else if(type === 'E') { classes.push(index); }
			else if(type === 'H') { functions.push(index); }
			else { cstrs.push(index); }
			return "";
		});
		var fields = declarations.replace(/^(?:\s*;)+/, "").split(/;(?:\s*;)*/g);
		var baseClassName, interfacesNames;
		var i;

		if(baseName !== undefined) {
			baseClassName = baseName.replace(/^\s*extends\s+([A-Za-z_$][\w$]*\b(?:\s*\.\s*[A-Za-z_$][\w$]*\b)*)\s*$/g, "$1");
		}

		if(interfaces !== undefined) {
			interfacesNames = interfaces.replace(/^\s*implements\s+(.+?)\s*$/g, "$1").split(/\s*,\s*/g);
		}

		for(i = 0; i < functions.length; ++i) {
			functions[i] = transformFunction(atoms[functions[i]]);
		}
		for(i = 0; i < methods.length; ++i) {
			methods[i] = transformClassMethod(atoms[methods[i]]);
		}
		for(i = 0; i < fields.length - 1; ++i) {
			var field = trimSpaces(fields[i]);
			fields[i] = transformClassField(field.middle);
		}
		var tail = fields.pop();
		for(i = 0; i < cstrs.length; ++i) {
			cstrs[i] = transformConstructor(atoms[cstrs[i]]);
		}
		for(i = 0; i < classes.length; ++i) {
			classes[i] = transformInnerClass(atoms[classes[i]]);
		}

		return new AstClassBody(name, baseClassName, interfacesNames, functions, methods, fields, cstrs,
			classes, { tail: tail });
	};

	function AstInterface(name, body) {
		this.name = name;
		this.body = body;
		body.owner = this;
	}
	AstInterface.prototype.toString = function() {
		return "var " + this.name + " = " + this.body + ";\n" +
			"$p." + this.name + " = " + this.name + ";\n";
	};
	function AstClass(name, body) {
		this.name = name;
		this.body = body;
		body.owner = this;
	}
	AstClass.prototype.toString = function() {
		return "var " + this.name + " = " + this.body + ";\n" +
			"$p." + this.name + " = " + this.name + ";\n";
	};

	function transformGlobalClass(class_) {
		var m = classesRegex.exec(class_); // 1 - attr, 2 - class|int, 3 - name, 4 - extends, 5 - implements, 6 - body
		classesRegex.lastIndex = 0;
		var body = atoms[getAtomIndex(m[6])];
		var oldClassId = currentClassId, newClassId = generateClassId();
		currentClassId = newClassId;
		var globalClass;
		if(m[2] === "interface") {
			globalClass = new AstInterface(m[3], transformInterfaceBody(body, m[3], m[4]) );
		} else {
			globalClass = new AstClass(m[3], transformClassBody(body, m[3], m[4], m[5]) );
		}
		appendClass(globalClass, newClassId, oldClassId);
		currentClassId = oldClassId;
		return globalClass;
	}

	function AstMethod(name, params, body) {
		this.name = name;
		this.params = params;
		this.body = body;
	}
	AstMethod.prototype.toString = function(){
		var paramNames = appendToLookupTable({}, this.params.getNames());
		var oldContext = replaceContext;
		replaceContext = function (subject) {
			return paramNames.hasOwnProperty(subject.name) ? subject.name : oldContext(subject);
		};
		var body = this.params.prependMethodArgs(this.body.toString());
		var result = "function " + this.name + this.params + " " + body + "\n" +
			"$p." + this.name + " = " + this.name + ";\n" +
			this.name + " = " + this.name + ".bind($p);";
		//        "$p." + this.name + " = " + this.name + ";";
		replaceContext = oldContext;
		return result;
	};

	function transformGlobalMethod(method) {
		var m = methodsRegex.exec(method);
		var result =
			methodsRegex.lastIndex = 0;
		return new AstMethod(m[3], transformParams(atoms[getAtomIndex(m[4])]),
			transformStatementsBlock(atoms[getAtomIndex(m[6])]));
	}

	function preStatementsTransform(statements) {
		var s = statements;
		// turns multiple catch blocks into one, because we have no way to properly get into them anyway.
		s = s.replace(/\b(catch\s*"B\d+"\s*"A\d+")(\s*catch\s*"B\d+"\s*"A\d+")+/g, "$1");
		return s;
	}

	function AstForStatement(argument, misc) {
		this.argument = argument;
		this.misc = misc;
	}
	AstForStatement.prototype.toString = function() {
		return this.misc.prefix + this.argument.toString();
	};
	function AstCatchStatement(argument, misc) {
		this.argument = argument;
		this.misc = misc;
	}
	AstCatchStatement.prototype.toString = function() {
		return this.misc.prefix + this.argument.toString();
	};
	function AstPrefixStatement(name, argument, misc) {
		this.name = name;
		this.argument = argument;
		this.misc = misc;
	}
	AstPrefixStatement.prototype.toString = function() {
		var result = this.misc.prefix;
		if(this.argument !== undefined) {
			result += this.argument.toString();
		}
		return result;
	};
	function AstSwitchCase(expr) {
		this.expr = expr;
	}
	AstSwitchCase.prototype.toString = function() {
		return "case " + this.expr + ":";
	};
	function AstLabel(label) {
		this.label = label;
	}
	AstLabel.prototype.toString = function() {
		return this.label;
	};

	transformStatements = function(statements, transformMethod, transformClass) {
		var nextStatement = new RegExp(/\b(catch|for|if|switch|while|with)\s*"B(\d+)"|\b(do|else|finally|return|throw|try|break|continue)\b|("[ADEH](\d+)")|\b(case)\s+([^:]+):|\b([A-Za-z_$][\w$]*\s*:)|(;)/g);
		var res = [];
		statements = preStatementsTransform(statements);
		var lastIndex = 0, m, space;
		// m contains the matches from the nextStatement regexp, null if there are no matches.
		// nextStatement.exec starts searching at nextStatement.lastIndex.
		while((m = nextStatement.exec(statements)) !== null) {
			if(m[1] !== undefined) { // catch, for ...
				var i = statements.lastIndexOf('"B', nextStatement.lastIndex);
				var statementsPrefix = statements.substring(lastIndex, i);
				if(m[1] === "for") {
					res.push(new AstForStatement(transformForExpression(atoms[m[2]]),
						{ prefix: statementsPrefix }) );
				} else if(m[1] === "catch") {
					res.push(new AstCatchStatement(transformParams(atoms[m[2]]),
						{ prefix: statementsPrefix }) );
				} else {
					res.push(new AstPrefixStatement(m[1], transformExpression(atoms[m[2]]),
						{ prefix: statementsPrefix }) );
				}
			} else if(m[3] !== undefined) { // do, else, ...
				res.push(new AstPrefixStatement(m[3], undefined,
					{ prefix: statements.substring(lastIndex, nextStatement.lastIndex) }) );
			} else if(m[4] !== undefined) { // block, class and methods
				space = statements.substring(lastIndex, nextStatement.lastIndex - m[4].length);
				if(trim(space).length !== 0) { continue; } // avoiding new type[] {} construct
				res.push(space);
				var kind = m[4].charAt(1), atomIndex = m[5];
				if(kind === 'D') {
					res.push(transformMethod(atoms[atomIndex]));
				} else if(kind === 'E') {
					res.push(transformClass(atoms[atomIndex]));
				} else if(kind === 'H') {
					res.push(transformFunction(atoms[atomIndex]));
				} else {
					res.push(transformStatementsBlock(atoms[atomIndex]));
				}
			} else if(m[6] !== undefined) { // switch case
				res.push(new AstSwitchCase(transformExpression(trim(m[7]))));
			} else if(m[8] !== undefined) { // label
				space = statements.substring(lastIndex, nextStatement.lastIndex - m[8].length);
				if(trim(space).length !== 0) { continue; } // avoiding ?: construct
				res.push(new AstLabel(statements.substring(lastIndex, nextStatement.lastIndex)) );
			} else { // semicolon
				var statement = trimSpaces(statements.substring(lastIndex, nextStatement.lastIndex - 1));
				res.push(statement.left);
				res.push(transformStatement(statement.middle));
				res.push(statement.right + ";");
			}
			lastIndex = nextStatement.lastIndex;
		}
		var statementsTail = trimSpaces(statements.substring(lastIndex));
		res.push(statementsTail.left);
		if(statementsTail.middle !== "") {
			res.push(transformStatement(statementsTail.middle));
			res.push(";" + statementsTail.right);
		}
		return res;
	};

	function getLocalNames(statements) {
		var localNames = [];
		for(var i=0,l=statements.length;i<l;++i) {
			var statement = statements[i];
			if(statement instanceof AstVar) {
				localNames = localNames.concat(statement.getNames());
			} else if(statement instanceof AstForStatement &&
				statement.argument.initStatement instanceof AstVar) {
					localNames = localNames.concat(statement.argument.initStatement.getNames());
				} else if(statement instanceof AstInnerInterface || statement instanceof AstInnerClass ||
					statement instanceof AstInterface || statement instanceof AstClass ||
						statement instanceof AstMethod || statement instanceof AstFunction) {
							localNames.push(statement.name);
						}
		}
		return appendToLookupTable({}, localNames);
	}

	function AstStatementsBlock(statements) {
		this.statements = statements;
	}
	AstStatementsBlock.prototype.toString = function() {
		var localNames = getLocalNames(this.statements);
		var oldContext = replaceContext;

		// replacing context only when necessary
		if(!isLookupTableEmpty(localNames)) {
			replaceContext = function (subject) {
				return localNames.hasOwnProperty(subject.name) ? subject.name : oldContext(subject);
			};
		}

		var result = "{\n" + this.statements.join('') + "\n}";
		replaceContext = oldContext;
		return result;
	};

	transformStatementsBlock = function(block) {
		var content = trimSpaces(block.substring(1, block.length - 1));
		return new AstStatementsBlock(transformStatements(content.middle));
	};

	function AstRoot(statements) {
		this.statements = statements;
	}
	AstRoot.prototype.toString = function() {
		var classes = [], otherStatements = [], statement;
		for (var i = 0, len = this.statements.length; i < len; ++i) {
			statement = this.statements[i];
			if (statement instanceof AstClass || statement instanceof AstInterface) {
				classes.push(statement);
			} else {
				otherStatements.push(statement);
			}
		}
		sortByWeight(classes);

		var localNames = getLocalNames(this.statements);
		replaceContext = function (subject) {
			var name = subject.name;
			if(localNames.hasOwnProperty(name)) {
				return name;
			}
			if(globalMembers.hasOwnProperty(name) ||
				defaultScope.PConstants.hasOwnProperty(name) ||
					defaultScope.hasOwnProperty(name)) {
						return "$p." + name;
					}
			return name;
		};
		var result = "// this code was autogenerated from PJS\n" +
		"(function($p) {\n" +
			classes.join('') + "\n" +
			otherStatements.join('') + "\n})";
		replaceContext = null;
		return result;
	};

	transformMain = function() {
		var statements = extractClassesAndMethods(atoms[0]);
		statements = statements.replace(/\bimport\s+[^;]+;/g, "");
		return new AstRoot( transformStatements(statements,
			transformGlobalMethod, transformGlobalClass) );
	};

	function generateMetadata(ast) {
		var globalScope = {};
		var id, class_;
		for(id in declaredClasses) {
			if(declaredClasses.hasOwnProperty(id)) {
				class_ = declaredClasses[id];
				var scopeId = class_.scopeId, name = class_.name;
				if(scopeId) {
					var scope = declaredClasses[scopeId];
					class_.scope = scope;
					if(scope.inScope === undefined) {
						scope.inScope = {};
					}
					scope.inScope[name] = class_;
				} else {
					globalScope[name] = class_;
				}
			}
		}

		function findInScopes(class_, name) {
			var parts = name.split('.');
			var currentScope = class_.scope, found;
			while(currentScope) {
				if(currentScope.hasOwnProperty(parts[0])) {
					found = currentScope[parts[0]]; break;
				}
				currentScope = currentScope.scope;
			}
			if(found === undefined) {
				found = globalScope[parts[0]];
			}
			for(var i=1,l=parts.length;i<l && found;++i) {
				found = found.inScope[parts[i]];
			}
			return found;
		}

		for(id in declaredClasses) {
			if(declaredClasses.hasOwnProperty(id)) {
				class_ = declaredClasses[id];
				var baseClassName = class_.body.baseClassName;
				if(baseClassName) {
					var parent = findInScopes(class_, baseClassName);
					if (parent) {
						class_.base = parent;
						if (!parent.derived) {
							parent.derived = [];
						}
						parent.derived.push(class_);
					}
				}
				var interfacesNames = class_.body.interfacesNames,
					interfaces = [], i, l;
				if (interfacesNames && interfacesNames.length > 0) {
					for (i = 0, l = interfacesNames.length; i < l; ++i) {
						var interface_ = findInScopes(class_, interfacesNames[i]);
						interfaces.push(interface_);
						if (!interface_) {
							continue;
						}
						if (!interface_.derived) {
							interface_.derived = [];
						}
						interface_.derived.push(class_);
					}
					if (interfaces.length > 0) {
						class_.interfaces = interfaces;
					}
				}
			}
		}
	}

	function setWeight(ast) {
		var queue = [], tocheck = {};
		var id, scopeId, class_;
		// queue most inner and non-inherited
		for (id in declaredClasses) {
			if (declaredClasses.hasOwnProperty(id)) {
				class_ = declaredClasses[id];
				if (!class_.inScope && !class_.derived) {
					queue.push(id);
					class_.weight = 0;
				} else {
					var dependsOn = [];
					if (class_.inScope) {
						for (scopeId in class_.inScope) {
							if (class_.inScope.hasOwnProperty(scopeId)) {
								dependsOn.push(class_.inScope[scopeId]);
							}
						}
					}
					if (class_.derived) {
						dependsOn = dependsOn.concat(class_.derived);
					}
					tocheck[id] = dependsOn;
				}
			}
		}
		function removeDependentAndCheck(targetId, from) {
			var dependsOn = tocheck[targetId];
			if (!dependsOn) {
				return false; // no need to process
			}
			var i = dependsOn.indexOf(from);
			if (i < 0) {
				return false;
			}
			dependsOn.splice(i, 1);
			if (dependsOn.length > 0) {
				return false;
			}
			delete tocheck[targetId];
			return true;
		}
		while (queue.length > 0) {
			id = queue.shift();
			class_ = declaredClasses[id];
			if (class_.scopeId && removeDependentAndCheck(class_.scopeId, class_)) {
				queue.push(class_.scopeId);
				declaredClasses[class_.scopeId].weight = class_.weight + 1;
			}
			if (class_.base && removeDependentAndCheck(class_.base.classId, class_)) {
				queue.push(class_.base.classId);
				class_.base.weight = class_.weight + 1;
			}
			if (class_.interfaces) {
				var i, l;
				for (i = 0, l = class_.interfaces.length; i < l; ++i) {
					if (!class_.interfaces[i] ||
						!removeDependentAndCheck(class_.interfaces[i].classId, class_)) {
							continue;
						}
					queue.push(class_.interfaces[i].classId);
					class_.interfaces[i].weight = class_.weight + 1;
				}
			}
		}
	}

	var transformed = transformMain();
	generateMetadata(transformed);
	setWeight(transformed);

	var redendered = transformed.toString();

	// remove empty extra lines with space
	redendered = redendered.replace(/\s*\n(?:[\t ]*\n)+/g, "\n\n");

	// convert character codes to characters
	redendered = redendered.replace(/__x([0-9A-F]{4})/g, function(all, hexCode) {
		return String.fromCharCode(parseInt(hexCode,16));
	});

	return injectStrings(redendered, strings);
}// Parser ends

// Processing global methods and constants for the parser
function getGlobalMembers(aFunctions) {
	// The names array contains the names of everything that is inside "p."
	// When something new is added to "p." it must also be added to this list.
	var names = [ /* this code is generated by jsglobals.js */
		"abs", "acos", "alpha", "ambient", "ambientLight", "append", "applyMatrix",
		"arc", "arrayCopy", "asin", "atan", "atan2", "background", "beginCamera",
		"beginDraw", "beginShape", "bezier", "bezierDetail", "bezierPoint",
		"bezierTangent", "bezierVertex", "binary", "blend", "blendColor",
		"blit_resize", "blue", "box", "breakShape", "brightness",
		"camera", "ceil", "Character", "color", "colorMode",
		"concat", "constrain", "copy", "cos", "createFont",
		"createGraphics", "createImage", "cursor", "curve", "curveDetail",
		"curvePoint", "curveTangent", "curveTightness", "curveVertex", "day",
		"degrees", "directionalLight", "disableContextMenu",
		"dist", "draw", "ellipse", "ellipseMode", "emissive", "enableContextMenu",
		"endCamera", "endDraw", "endShape", "exit", "exp", "expand", "externals",
		"fill", "filter", "floor", "focused", "frameCount", "frameRate", "frustum",
		"get", "glyphLook", "glyphTable", "green", "height", "hex", "hint", "hour",
		"hue", "image", "imageMode", "intersect", "join", "key",
		"keyCode", "keyPressed", "keyReleased", "keyTyped", "lerp", "lerpColor",
		"lightFalloff", "lights", "lightSpecular", "line", "link", "loadBytes",
		"loadFont", "loadGlyphs", "loadImage", "loadPixels", "loadShape", "loadXML",
		"loadStrings", "log", "loop", "mag", "map", "match", "matchAll", "max",
		"millis", "min", "minute", "mix", "modelX", "modelY", "modelZ", "modes",
		"month", "mouseButton", "mouseClicked", "mouseDragged", "mouseMoved",
		"mouseOut", "mouseOver", "mousePressed", "mouseReleased", "mouseScroll",
		"mouseScrolled", "mouseX", "mouseY", "name", "nf", "nfc", "nfp", "nfs",
		"noCursor", "noFill", "noise", "noiseDetail", "noiseSeed", "noLights",
		"noLoop", "norm", "normal", "noSmooth", "noStroke", "noTint", "ortho",
		"param", "parseBoolean", "parseByte", "parseChar", "parseFloat",
		"parseInt", "peg", "perspective", "PImage", "pixels", "PMatrix2D",
		"PMatrix3D", "PMatrixStack", "pmouseX", "pmouseY", "point",
		"pointLight", "popMatrix", "popStyle", "pow", "print", "printCamera",
		"println", "printMatrix", "printProjection", "PShape", "PShapeSVG",
		"pushMatrix", "pushStyle", "quad", "radians", "random", "Random",
		"randomSeed", "rect", "rectMode", "red", "redraw", "requestImage",
		"resetMatrix", "reverse", "rotate", "rotateX", "rotateY", "rotateZ",
		"round", "saturation", "save", "saveFrame", "saveStrings", "scale",
		"screenX", "screenY", "screenZ", "second", "set", "setup", "shape",
		"shapeMode", "shared", "shearX", "shearY", "shininess", "shorten", "sin", "size", "smooth",
		"sort", "specular", "sphere", "sphereDetail", "splice", "split",
		"splitTokens", "spotLight", "sq", "sqrt", "status", "str", "stroke",
		"strokeCap", "strokeJoin", "strokeWeight", "subset", "tan", "text",
		"textAlign", "textAscent", "textDescent", "textFont", "textLeading",
		"textMode", "textSize", "texture", "textureMode", "textWidth", "tint", "toImageData",
		"touchCancel", "touchEnd", "touchMove", "touchStart", "translate", "transform",
		"triangle", "trim", "unbinary", "unhex", "updatePixels", "use3DContext",
		"vertex", "width", "XMLElement", "XML", "year", "__contains", "__equals",
		"__equalsIgnoreCase", "__frameRate", "__hashCode", "__int_cast",
		"__instanceof", "__keyPressed", "__mousePressed", "__printStackTrace",
		"__replace", "__replaceAll", "__replaceFirst", "__toCharArray", "__split",
		"__codePointAt", "__startsWith", "__endsWith", "__matches"];

	// custom functions and properties are added here
	if(aFunctions) {
		Object.keys(aFunctions).forEach(function(name) {
			names.push(name);
		});
	}

	// custom libraries that were attached to Processing
	var members = {};
	var i, l;
	for (i = 0, l = names.length; i < l ; ++i) {
		members[names[i]] = null;
	}
	for (var lib in Processing.lib) {
		if (Processing.lib.hasOwnProperty(lib)) {
			if (Processing.lib[lib].exports) {
				var exportedNames = Processing.lib[lib].exports;
				for (i = 0, l = exportedNames.length; i < l; ++i) {
					members[exportedNames[i]] = null;
				}
			}
		}
	}
	return members;
}

// masks parentheses, brackets and braces with '"A5"'
// where A is the bracket type, and 5 is the index in an array containing all brackets split into atoms
// 'while(true){}' -> 'while"B1""A2"'
// parentheses() = B, brackets[] = C and braces{} = A
function splitToAtoms(code) {
	var atoms = [];
	var items = code.split(/([\{\[\(\)\]\}])/);
	var result = items[0];
	var stack = [];

	for (var i=1; i < items.length; i += 2) {
		var item = items[i];

		if (item === '[' || item === '{' || item === '(') {
			stack.push(result);
			result = item;
		} else if(item === ']' || item === '}' || item === ')') {
			var kind = item === '}' ? 'A' : item === ')' ? 'B' : 'C';
			var index = atoms.length;

			atoms.push(result + item);
			result = stack.pop() + '"' + kind + (index + 1) + '"';
		}
		result += items[i + 1];
	}

	atoms.unshift(result);
	return atoms;
}
