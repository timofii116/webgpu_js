import { TranspiledShader } from "./types";

//transpile js(ish) functions to webgpu and generate/combine bindings
export class WGSLTranspiler {

    static builtInUniforms = {
        resX:{type:'f32',callback:(shaderContext)=>{return shaderContext.canvas ? shaderContext.canvas.width : window.innerWidth;}}, 
        resY:{type:'f32',callback:(shaderContext)=>{return shaderContext.canvas ? shaderContext.canvas.height : window.innerHeight;}}, //canvas resolution
        mouseX:{type:'f32',callback:(shaderContext)=>{
            if(!shaderContext.MOUSEMOVELISTENER) {
                let elm = shaderContext.canvas ? shaderContext.canvas : window;
                shaderContext.MOUSEMOVELISTENER = elm.onmousemove = (evt) => {
                    shaderContext.mouseX = evt.offsetX;
                    shaderContext.mouseY = evt.offsetY;
                }
                shaderContext.mouseX = 0;
            }
            return shaderContext.mouseX;
        }}, mouseY:{type:'f32',callback:(shaderContext)=>{
            if(!shaderContext.MOUSEMOVELISTENER) {
                let elm = shaderContext.canvas ? shaderContext.canvas : window;
                shaderContext.MOUSEMOVELISTENER = elm.onmousemove = (evt) => { //should set in the same place as mouseX
                    shaderContext.mouseX = evt.offsetX;
                    shaderContext.mouseY = evt.offsetY;
                }
                shaderContext.mouseY = 0;
            }
            return shaderContext.mouseY;
        }}, //mouse position
        clicked:{ type:'i32', //onmousedown
            callback:(shaderContext) => {
                if(!shaderContext.MOUSEDOWNLISTENER) {
                    let elm = shaderContext.canvas ? shaderContext.canvas : window;
                    shaderContext.MOUSEDOWNLISTENER = elm.onmousedown = (evt) => { //should set in the same place as mouseX
                        shaderContext.clicked = true;
                    }
                    shaderContext.MOUSEUPLISTENER = elm.onmouseup = (evt) => {
                        shaderContext.clicked = false;
                    }
                    //should do mobile device
                    shaderContext.clicked = false;
                }
                return shaderContext.clicked;
            }
        },
        //keyinputs
        frame:{type:'f32',callback:function(shaderContext){
            if(!shaderContext.frame) shaderContext.frame = 0;
            let result = shaderContext.frame;
            shaderContext.frame++;
            return result;
        }}, //frame counter
        utcTime:{type:'f32',callback:(shaderContext)=>{return Date.now();}} //utc time                 
    } //etc.. more we can add from shaderToy

    static getFunctionHead = (methodString) => {
        let startindex = methodString.indexOf('=>')+1;
        if(startindex <= 0) {
            startindex = methodString.indexOf('){');
        }
        if(startindex <= 0) {
            startindex = methodString.indexOf(') {');
        }
        return methodString.slice(0, methodString.indexOf('{',startindex) + 1);
    }

    static splitIgnoringBrackets = (str) => {
        const result = [] as any[];
        let depth = 0; // depth of nested structures
        let currentToken = '';
        for (let i = 0; i < str.length; i++) {
            const char = str[i];

            if (char === ',' && depth === 0) {
                result.push(currentToken);
                currentToken = '';
            } else {
                currentToken += char;
                if (char === '(' || char === '[' || char === '{') {
                    depth++;
                } else if (char === ')' || char === ']' || char === '}') {
                    depth--;
                }
            }
        }

        // This is the change: Ensure any remaining content in currentToken is added to result
        if (currentToken) {
            result.push(currentToken);
        }

        return result;
    }

    static tokenize(funcStr) {
        // Capture function parameters
        let head = this.getFunctionHead(funcStr);
        let paramString = head.substring(head.indexOf('(') + 1, head.lastIndexOf(')'));
        let params = this.splitIgnoringBrackets(paramString).map(param => ({
            token: param,
            isInput: true
        }));

        // Capture variables, arrays, and their assignments
        const assignmentTokens = (funcStr.match(/(const|let|var)\s+(\w+)\s*=\s*([^;]+)/g) || []).map(token => ({
            token,
            isInput: false
        }));

        // Capture built-in uniforms
        const builtInUniformsKeys = Object.keys(this.builtInUniforms).join("|");
        const builtInUniformsPattern = new RegExp(`(?<![a-zA-Z0-9_])(${builtInUniformsKeys})(?![a-zA-Z0-9_])`, 'g');

        const builtInUniformsTokens = (funcStr.match(builtInUniformsPattern) || []).map(token => ({
            token,
            isInput: false // or true, based on your requirements
        }));

        // Exclude the function head (declaration) from the function call matching
        let functionBody = funcStr.substring(funcStr.indexOf('{') + 1, funcStr.lastIndexOf('}'));
        
        // Capture variable names referenced inside of function calls, excluding numbers and vec/mat constructs
        const textureCallTokens = (functionBody.match(/texture.*\w+\(([^)]+)\)/g) || []).flatMap(call => {
            // Extract arguments from each function call
            let args = call.substring(call.indexOf('(') + 1, call.lastIndexOf(')'));
            return this.splitIgnoringBrackets(args).map(arg => {
                arg = arg.trim();
                // Exclude if argument is a number, vec, or mat, unless it contains nested variable names
                if (!isNaN(arg) || /^.*(vec|mat).*\(/.test(arg)) {
                    return null;
                }
                return { token: arg, isInput: false };
            }).filter(arg => arg !== null);
        });
        params =  params.concat(assignmentTokens);
        params = params.concat(builtInUniformsTokens);
        params = params.concat(textureCallTokens);
        // Combine both sets of tokens
        return params;
    }

    static excludedNames = {
        'color':true,
        'position':true,
        'uv':true,
        'vertex':true,
        'normal':true,
        'pixel':true
    }

    static parse = (fstr, tokens, shaderType='compute') => {
        const ast = [] as any[];
        // Extract all returned variables from the tokens
        const returnMatches = fstr.match(/^(?![ \t]*\/\/).*\breturn .*;/gm);
        let returnedVars = returnMatches ? returnMatches.map(match => match.replace(/^[ \t]*return /, '').replace(';', '')) : undefined;

        returnedVars = this.flattenStrings(returnedVars);


        const functionBody = fstr.substring(fstr.indexOf('{')); 
        //basic function splitting, we dont support object inputs right now, anyway. e.g. we could add {x,y,z} objects to define vectors
        let checked = {};
        tokens.forEach(({ token, isInput },i) => {
            if(checked[token]) return; //skip redundancies
            checked[token] = true;
            let isReturned = returnedVars?.find((v) => {
                if(token.includes(v)) {
                    if(
                        (shaderType !== 'compute' &&
                        Object.keys(this.excludedNames).find((t) => token.includes(t)) ||
                        Object.keys(this.builtInUniforms).find((t) => token.includes(t)))
                    ) {
                        tokens[i].isInput = false;
                    }
                    else return true;
                }
            });
            let isModified = new RegExp(`\\b${token.split('=')[0]}\\b(\\[\\w+\\])?\\s*=`).test(functionBody);

            if (token.includes('=')) {
                const variableMatch = token.match(/(const|let|var)?\s*(\w+)\s*=\s*(.+)/);
                if (variableMatch && (variableMatch[3].startsWith('new') || variableMatch[3].startsWith('['))) {
                    let length;
                    if (variableMatch[3].startsWith('new Array(')) {
                        // Match array size from new Array(512) pattern
                        const arrayLengthMatch = variableMatch[3].match(/new Array\((\d+)\)/);
                        length = arrayLengthMatch ? parseInt(arrayLengthMatch[1]) : undefined;
                    } else if (variableMatch[3].startsWith('new')) {
                        // Match from typed array pattern like new Float32Array([1,2,3])
                        const typedArrayLengthMatch = variableMatch[3].match(/new \w+Array\(\[([^\]]+)\]\)/);
                        length = typedArrayLengthMatch ? typedArrayLengthMatch[1].split(',').length : undefined;
                    } else {
                        // Match from direct array declaration like [1,2,3]
                        const directArrayLengthMatch = variableMatch[3].match(/\[([^\]]+)\]/);
                        length = directArrayLengthMatch ? directArrayLengthMatch[1].split(',').length : undefined;
                    }

                    ast.push({
                        type: 'array',
                        name: variableMatch[2],
                        value: variableMatch[3],
                        isInput,
                        length: length, // Added this line to set the extracted length
                        isReturned: returnedVars ? returnedVars?.includes(variableMatch[2]) : isInput ? true : false,
                        isModified
                    });
                } else if (token.startsWith('vec') || token.startsWith('mat')) {
                    const typeMatch = token.match(/(vec\d|mat\d+x\d+)\(([^)]+)\)/);
                    if (typeMatch) {
                        ast.push({
                            type: typeMatch[1],
                            name: token.split('=')[0],
                            value: typeMatch[2],
                            isInput,
                            isReturned: returnedVars ? returnedVars?.includes(token.split('=')[0]) : isInput ? true : false,
                            isModified
                        });
                    }
                } else {

                    ast.push({
                        type: 'variable',
                        name: variableMatch[2],
                        value: variableMatch[3],
                        isUniform:true,
                        isInput,
                        isReturned: returnedVars ? returnedVars?.includes(variableMatch[2]) : isInput ? true : false,
                        isModified
                    });
                }
            } else {
                // This is a function parameter without a default value
                ast.push({
                    type: 'variable',
                    name: token,
                    value: 'unknown',
                    isInput,
                    isReturned,
                    isModified
                });
            }
        });

        return ast;
    }

    static inferTypeFromValue(value, funcStr, ast, defaultValue:any='f32') {
        value=value.trim()
        if(value === 'true' || value === 'false') return 'bool';
        else if(value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return value.substring(1,value.length-1); //should extract string types
        else if (value.startsWith('vec')) {
            const floatVecMatch = value.match(/vec(\d)f/);
            if (floatVecMatch) {
                return floatVecMatch[0]; // Returns vec(n)f as-is
            }
            const vecTypeMatch = value.match(/vec(\d)\(/); // Check if the value starts with vec(n) pattern
            if (vecTypeMatch) {
                const vecSize = vecTypeMatch[1];
                const type = value.includes('.') ? `<f32>` : `<i32>`;
                return `vec${vecSize}${type}`;
            }
        } else if (value.startsWith('mat')) {
            const type = '<f32>'//value.includes('.') ? '<f32>' : '<i32>'; //f16 and f32 only supported in mats
            return value.match(/mat(\d)x(\d)/)[0] + type;
        } else if (value.startsWith('[')) {
            // Infer the type from the first element if the array is initialized with values
            const firstElement = value.split(',')[0].substring(1);
            if(firstElement === ']') return 'array<f32>';
            if (firstElement.startsWith('[') && !firstElement.endsWith(']')) {
                // Only recurse if the first element is another array and not a complete array by itself
                return this.inferTypeFromValue(firstElement, funcStr, ast);
            } else {
                // Check if the first element starts with vec or mat
                if (firstElement.startsWith('vec') || firstElement.startsWith('mat')) {
                    return `array<${this.inferTypeFromValue(firstElement, funcStr, ast)}>`;
                } else if (firstElement.includes('.')) {
                    return 'array<f32>';
                } else if (!isNaN(firstElement)) {
                    return 'array<i32>';
                }
            }
        } else if (value.startsWith('new Array')) {
            // If the array is initialized using the `new Array()` syntax, look for assignments in the function body
            const arrayNameMatch = value.match(/let\s+(\w+)\s*=/);
            if (arrayNameMatch) {
                const arrayName = arrayNameMatch[1];
                const assignmentMatch = funcStr.match(new RegExp(`${arrayName}\\[\\d+\\]\\s*=\\s*(.+?);`));
                if (assignmentMatch) {
                    return this.inferTypeFromValue(assignmentMatch[1], funcStr, ast);
                }
            } else return 'f32'
        } else if (value.startsWith('new Float32Array')) {
            return 'array<f32>';
        } else if (value.startsWith('new Float64Array')) {
            return 'array<f64>'
        } else if (value.startsWith('new Int8Array')) {
            return 'array<i8>';
        } else if (value.startsWith('new Int16Array')) {
            return 'array<i16>';
        } else if (value.startsWith('new Int32Array')) {
            return 'array<i32>';
        } else if (value.startsWith('new BigInt64Array')) { 
            return 'array<i64>';
        } else if (value.startsWith('new BigUInt64Array')) { 
            return 'array<u64>';
        } else if (value.startsWith('new Uint8Array') || value.startsWith('new Uint8ClampedArray')) {
            return 'array<u8>';
        } else if (value.startsWith('new Uint16Array')) {
            return 'array<u16>';
        } else if (value.startsWith('new Uint32Array')) {
            return 'array<u32>';
        } else if (value.includes('.')) {
            return 'f32';  // Float type for values with decimals
        } else if (!isNaN(value)) {
            return 'i32';  // Int type for whole numbers
        } else {
             // Check if the value is a variable name and infer its type from AST
            const astNode = ast.find(node => node.name === value);
            if (astNode) {
                if (astNode.type === 'array') {
                    return 'f32';  // Assuming all arrays are of type f32 for simplicity
                } else if (astNode.type === 'variable') {
                    return this.inferTypeFromValue(astNode.value, funcStr, ast);
                }
            }
        }
        
        return defaultValue;  // For other types
    }

    static flattenStrings(arr) {
        if(!arr) return [] as any[];
        const callback = (item, index, array) => {
            if (item.startsWith('[') && item.endsWith(']')) {
                return item.slice(1, -1).split(',').map(s => s.trim());
            }
            return item;
        }
        return arr.reduce((acc, value, index, array) => {
            return acc.concat(callback(value, index, array));
        }, [] as any[]);
    }

    static generateDataStructures(
        funcStr, 
        ast, 
        bindGroup=0, 
        shaderType?:'compute'|'fragment'|'vertex',
        variableTypes?:{[key:string]:string|{binding:string}},
        minBinding=0
    ) {
        let code = '//Bindings (data passed to/from CPU) \n';
        // Extract all returned variables from the function string
        // const returnMatches = funcStr.match(/^(?![ \t]*\/\/).*\breturn .*;/gm);
        // let returnedVars = returnMatches ? returnMatches.map(match => match.replace(/^[ \t]*return /, '').replace(';', '')) : undefined;

        // returnedVars = this.flattenStrings(returnedVars);

        // Capture all nested functions
        const functionRegex = /function (\w+)\(([^()]*|\((?:[^()]*|\([^()]*\))*\))*\) \{([\s\S]*?)\}/g;
        let modifiedStr = funcStr;

        let match;
        while ((match = functionRegex.exec(funcStr)) !== null) {
            // Replace the content of the nested function with a placeholder
            modifiedStr = modifiedStr.replace(match[3], 'PLACEHOLDER');
        }

        // Now, search for return statements in the modified string
        const returnMatches = modifiedStr.match(/^(?![ \t]*\/\/).*\breturn .*;/gm);
        let returnedVars = returnMatches ? returnMatches.map(match => match.replace(/^[ \t]*return /, '').replace(';', '')) : undefined;
        returnedVars = this.flattenStrings(returnedVars);

        let uniformsStruct = ''; // Start the UniformsStruct
        let defaultsStruct = '';
        let hasUniforms = false as any; // Flag to check if there are any uniforms
        let defaultUniforms;

        const params = [] as any[];

        let bindingIncr = minBinding;

        let names = {};
        let prevTextureBinding;
        ast.forEach((node, i) => {
            if(names[node.name]) return;
            names[node.name] = true;
            if(returnedVars.includes(node.name) && !this.excludedNames[node.name]) node.isInput = true; //catch extra returned variables not in the explicit input buffers (data structures generated by webgpu)
            function escapeRegExp(string) {
                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');  // $& means the whole matched string
            }

            //todo: texture types - texture_1d, texture_2d, texture_2d_array, texture_3d
            //methods for parsing texture types, we didn't really have a choice but to use variable names for implicit texture typing, but it should work in general
            if (new RegExp(`textureSampleCompare\\(${escapeRegExp(node.name)},`).test(funcStr)) { 
                
                let nm = node.name.toLowerCase();
                if(nm.includes('deptharr')) node.isDepthTextureArray = true;
                else if(nm.includes('depth')) node.isDepthTexture2d = true;
                else if(nm.includes('cubearr')) node.isDepthCubeArrayTexture = true;
                else if(nm.includes('cube')) node.isDepthCubeTexture = true;
                else if(nm.includes('ms2d')) node.isDepthMSAATexture = true;

                node.isTexture = true;
                node.isDepthTexture = true;
                prevTextureBinding = bindingIncr; //the output texture should share the binding (this is rudimentary, we can't really anticipate better than this)
            
            } else if(new RegExp(`textureSampleCompare\\(\\w+\\s*,\\s*${escapeRegExp(node.name)}`).test(funcStr)) {
                
                node.isComparisonSampler = true;
                node.isSampler = true;
            
            } else if (new RegExp(`textureSample\\(\\w+\\s*,\\s*${escapeRegExp(node.name)}`).test(funcStr)) { 
                
                node.isSampler = true;
            
            } else if(new RegExp(`textureStore\\(${escapeRegExp(node.name)},`).test(funcStr)) {
                
                let nm = node.name.toLowerCase();
                if(nm.includes('3d')) node.is3dStorageTexture = true;
                else if(nm.includes('1d')) node.is1dStorageTexture = true;
                else if(nm.includes('2darr')) node.is2dStorageTextureArray = true;
                
                node.isStorageTexture = true;
                if(prevTextureBinding !== undefined) node.isSharedStorageTexture = true; //shares a binding with a texture (assumed if following a texture)
            
            } else if (new RegExp(`texture.*\\(${escapeRegExp(node.name)},`).test(funcStr)) { //todo: we could infer texture dimensions from the second input type
                
                let nm = node.name.toLowerCase();

                //rudimentary way to dynamically type textures since we can't predict based on texture function calls
                if(nm.includes('deptharr')) node.isDepthTextureArray = true;
                else if(nm.includes('depthcubearr')) node.isDepthCubeArrayTexture = true;
                else if(nm.includes('depthcube')) node.isDepthCubeTexture = true;
                else if(nm.includes('depthms2d')) node.isDepthMSAATexture = true;
                else if(nm.includes('depth')) node.isDepthTexture2d = true;
                else if(nm.includes('cubearr')) node.isCubeArrayTexture = true;
                else if(nm.includes('cube')) node.isCubeTexture = true;
                else if(nm.includes('3d')) node.is3dTexture = true;
                else if(nm.includes('2darr')) node.is2dTextureArray = true;
                else if(nm.includes('1d')) node.is1dTexture = true;
                else if(nm.includes('ms2d')) node.is2dMSAATexture = true;
                 
                if(nm.includes('depth')) 
                    node.isDepthTexture = true;

                node.isTexture = true;
                prevTextureBinding = bindingIncr;
            } 

            node.binding = bindingIncr;
            node.group = bindGroup;

            if(variableTypes?.[node.name]) {
                if(typeof variableTypes[node.name] === 'string') {
                    code += `@group(${bindGroup}) @binding(${bindingIncr}) var ${node.name}: ${variableTypes[node.name]};\n\n`;
                }
                else if ('binding' in (variableTypes[node.name] as any)) {
                    code += (variableTypes[node.name] as any).binding;
                }
                bindingIncr++;
                params.push(node);
                return;
            } 

            if (node.isTexture) {
                params.push(node);

                let format = node.name.includes('i32') ? 'i32' : node.name.includes('u32') ? 'u32' : 'f32';
            
                let typ;
                if(node.isDepthTextureArray) typ = 'texture_depth_2d_array';
                else if(node.isDepthCubeArrayTexture) typ = 'texture_depth_cube_array';
                else if(node.isDepthMSAATexture) typ = 'texture_depth_multisampled_2d';
                else if(node.isDepthCubeTexture) typ = 'texture_depth_cube';
                else if(node.isDepthTexture2d) typ = 'texture_depth_2d';
                else if(node.isCubeArrayTexture) typ = 'texture_cube_array<'+format+'>';
                else if(node.isCubeTexture) typ = 'texture_cube<'+format+'>';
                else if(node.is3dTexture) typ = 'texture_3d<'+format+'>';
                else if(node.is2dTextureArray) typ = 'texture_2d_array<'+format+'>';
                else if(node.is1dTexture) typ = 'texture_1d<'+format+'>';
                else if(node.is2dMSAATexture) typ = 'texture_multisampled_2d<'+format+'>';
                else typ = `texture_2d<f32>`;

                code += `@group(${bindGroup}) @binding(${bindingIncr}) var ${node.name}: ${typ};\n`;
                //else  code += `@group(${bindGroup}) @binding(${bindingIncr}) var ${node.name}: texture_storage_2d<${storageTextureType}, write>;\n\n`; //todo: rgba8unorm type should be customizable
                bindingIncr++;

            } else if (node.isStorageTexture) { 

                let format = textureFormats.find((f) => {if(node.name.includes(f)) return true;});
                if(!format) format = 'rgba8unorm';

                let typ; 
                if(node.is3dStorageTexture) typ = 'texture_storage_3d<'+format+',write>'; //todo: read and read_write currently experimental: https://developer.chrome.com/blog/new-in-webgpu-118/ But we should default to read_write when we can
                else if(node.is1dStorageTexture) typ = 'texture_storage_3d<'+format+',write>';
                else if (node.is2dStorageTextureArray) typ = 'texture_storage_2d_array<'+format+',write>';
                else typ = 'texture_storage_2d<'+format+',write>';

                params.push(node);
                code += `@group(${bindGroup}) @binding(${bindingIncr}) var ${node.name}: ${typ};\n`; //todo rgba8unorm is not only type
                
                if(typeof prevTextureBinding === 'undefined') //e.g. texture_2d in the vertex on binding 0 is written to on the compute on the storage texture on binding 0
                    bindingIncr++; 
                else prevTextureBinding = undefined; //reset, we're just assuming if a texture input is followed by a storage texture, we'll give them the same binding
            
            } else if (node.isSampler) {
                let typ;
                
                if(node.isComparisonSampler) typ = 'sampler_comparison';
                else typ = 'sampler';

                params.push(node);
                code += `@group(${bindGroup}) @binding(${bindingIncr}) var ${node.name}: ${typ};\n\n`;
                bindingIncr++;
            
            } else if(node.isInput && !this.builtInUniforms[node.name]) {
                if (node.type === 'array') {
                    const elementType = this.inferTypeFromValue(node.value.split(',')[0], funcStr, ast);
                    
                    node.type = elementType; // Use the inferred type directly
                    params.push(node);
                    code += `struct ${capitalizeFirstLetter(node.name)}Struct {\n    values: ${elementType}\n};\n\n`;
                    code += `@group(${bindGroup}) @binding(${bindingIncr})\n`;
                    
                    if (!returnedVars || returnedVars?.includes(node.name)) {
                        code += `var<storage, read_write> ${node.name}: ${capitalizeFirstLetter(node.name)}Struct;\n\n`;
                    } else {
                        code += `var<storage, read> ${node.name}: ${capitalizeFirstLetter(node.name)}Struct;\n\n`;
                    }

                    bindingIncr++;

                }
                else if (node.isUniform) {
                    //if(shaderType === 'vertex') console.log(node);
                    
                    if(!hasUniforms) {
                        uniformsStruct = `struct UniformsStruct {\n`;
                        hasUniforms = bindingIncr; // Set the flag to the index
                        bindingIncr++;
                    }
                    
                    const uniformType = this.inferTypeFromValue(node.value, funcStr, ast);
                    node.type = uniformType;
                    params.push(node);
                    uniformsStruct += `    ${node.name}: ${uniformType},\n`; // Add the uniform to the UniformsStruct
                    
                }
            } else if(this.builtInUniforms[node.name]) {
                
                if(!defaultUniforms) {
                    defaultUniforms = [] as any[];
                    defaultsStruct = `struct DefaultUniforms {\n`;
                }

                const uniformType = this.builtInUniforms[node.name].type;
                defaultsStruct += `    ${node.name}: ${uniformType},\n`; // Add the uniform to the UniformsStruct
                defaultUniforms.push(node.name);
            
            }
        });

        if(defaultUniforms) {
        
            defaultsStruct += '};\n\n';
            code += defaultsStruct;
            code += `@group(${bindGroup}) @binding(${bindingIncr}) var<uniform> defaults: DefaultUniforms;\n\n`; //the last binding will always be default uniforms in this case
            bindingIncr++;
        
        }

        if (hasUniforms !== false) { // If there are any uniforms, add the UniformsStruct and its binding to the code
        
            uniformsStruct += '};\n\n'; // Close the UniformsStruct
            code += uniformsStruct;
            code += `@group(${bindGroup}) @binding(${hasUniforms}) var<uniform> uniforms: UniformsStruct;\n\n`;
        
        }

        return {code, params, defaultUniforms, lastBinding:bindingIncr};
    }

    static extractAndTransposeInnerFunctions = (body, extract=true, ast, params, shaderType) => {
        
        const functionRegex = /function (\w+)\(([^()]*|\((?:[^()]*|\([^()]*\))*\))*\) \{([\s\S]*?)\}/g;

        let match;
        let extractedFunctions = '';
        
        while ((match = functionRegex.exec(body)) !== null) {

            const functionHead = match[0];
            const funcName = match[1];
            const funcBody = match[3];
            let paramString = functionHead.substring(functionHead.indexOf('(') + 1, functionHead.lastIndexOf(')'));

            let outputParam;

            const regex = /return\s+([\s\S]*?);/;
            const retmatch = body.match(regex);
            if(retmatch) {
                let inferredType = this.inferTypeFromValue(retmatch[1], body, ast, false);
                if(inferredType) {
                    outputParam = inferredType;
                }
            }

            let params = this.splitIgnoringBrackets(paramString).map((p) => { 
                let split = p.split('=');
                let vname = split[0];
                let inferredType = this.inferTypeFromValue(split[1], body, ast);
                if(!outputParam) outputParam = inferredType;
                return vname+': '+inferredType;
            });

            // Transpose the function body
            const transposedBody = this.transposeBody(funcBody, funcBody, params, shaderType, true, undefined, false).code; // Assuming AST is not used in your current implementation

            //todo: infer output types better, instead of just assuming from the first input type
            extractedFunctions += `fn ${funcName}(${params}) -> ${outputParam} {${transposedBody}}\n\n`;
        }

        // Remove the inner functions from the main body
        if(extract) body = body.replace(functionRegex, '');

        return { body, extractedFunctions };
    }

    static generateMainFunctionWorkGroup(
        funcStr:string, 
        ast:any, 
        params:any, 
        shaderType ='compute', 
        nVertexBuffers=1, 
        workGroupSize=256, 
        gpuFuncs:(Function|string)[]
    ) {
        let code = '';
        
        if(gpuFuncs) {
            gpuFuncs.forEach((f:Function|string) => {
                let result = this.extractAndTransposeInnerFunctions(typeof f === 'function' ? f.toString() : f, false, ast, params, shaderType);
                if(result.extractedFunctions) code += result.extractedFunctions;
            })
        }

        // Extract inner functions and transpose them
        const { body: mainBody, extractedFunctions } = this.extractAndTransposeInnerFunctions(funcStr.match(/{([\s\S]+)}/)[1], true, ast, params, shaderType);
        
        // Prepend the transposed inner functions to the main function
        code += extractedFunctions;

        let vtxInps;
        let vboInputStrings = [] as any[];
        if(shaderType === 'vertex' || shaderType === 'fragment') {

            let vboStrings = Array.from({length: nVertexBuffers}, (_, i) => {
                if(shaderType === 'vertex') vboInputStrings.push(
                    
`@location(${4*i}) vertex${i>0 ? i+1 : ''}In: vec4<f32>, 
    @location(${4*i+1}) color${i>0 ? i+1 : ''}In: vec4<f32>,
    @location(${4*i+2}) uv${i>0 ? i+1 : ''}In: vec2<f32>,
    @location(${4*i+3}) normal${i>0 ? i+1 : ''}In: vec3<f32>${i===nVertexBuffers-1 ? '' : ','}`
                );
                return `
    @location(${4*i}) vertex${i>0 ? i+1 : ''}: vec4<f32>,
    @location(${4*i+1}) color${i>0 ? i+1 : ''}: vec4<f32>, 
    @location(${4*i+2}) uv${i>0 ? i+1 : ''}: vec2<f32>,
    @location(${4*i+3}) normal${i>0 ? i+1 : ''}: vec3<f32>${i===nVertexBuffers-1 ? '' : ','}`;
            });

            vtxInps = `
    @builtin(position) position: vec4<f32>, //pixel location
    //uploaded vertices from CPU, in interleaved format
${vboStrings.join('\n')}`;

            code += `
struct Vertex {
    ${vtxInps}
};
`;
        }

        // Generate function signature
        if(shaderType === 'compute') {

            code += `
//Main function call\n//threadId tells us what x,y,z thread we are on\n
@compute @workgroup_size(${workGroupSize})
fn compute_main(  
    @builtin(global_invocation_id) threadId: vec3<u32>, //shader grid position
    @builtin(local_invocation_id) localId: vec3<u32>,   //workgroup grid position
    @builtin(local_invocation_index) localIndex: u32,   //linear index within workgroup grid
    @builtin(num_workgroups) workgroups: vec3<u32>,     //dispatch size (x,y,z) group count
    @builtin(workgroup_id) workgroupId: vec3<u32>       //position of workgroup in compute shader grid`;     
            code += '\n) {\n';

        } else if (shaderType === 'vertex') {
            code += `
@vertex
fn vtx_main(
    @builtin(vertex_index) vertexIndex : u32,   //current vertex
    @builtin(instance_index) instanceIndex: u32, //current instance
    ${vboInputStrings.join('\n')}`
            code += '\n) -> Vertex {\n    var pixel: Vertex;\n'; //pixel is predeclared, can we can reference color, position, etc in our js-side shaders

        } else if (shaderType === 'fragment') {
            code += `
@fragment
fn frag_main(
    pixel: Vertex,
    @builtin(front_facing) is_front: bool,   //true when current fragment is on front-facing primitive
    @builtin(sample_index) sampleIndex: u32, //sample index for the current fragment
    @builtin(sample_mask) sampleMask: u32   //contains a bitmask indicating which samples in this fragment are covered by the primitive being rendered
) -> @location(0) vec4<f32> {\n`;
        }
        let shaderHead = code;
        // Transpose the main body
        let transposed = this.transposeBody(mainBody, funcStr, params, shaderType, shaderType === 'fragment', shaderHead, true);
        code += transposed.code;
        if(transposed.consts?.length > 0) 
            code = transposed.consts.join('\n') + '\n\n' + code;

        if (shaderType === 'vertex') code += `\n    return pixel; \n`; //
        code += '\n}\n';
        return code;
    }

    static transposeBody = (body, funcStr, params, shaderType, returns = false, shaderHead='', extractConsts=false) => {
        let code = '';

        // Capture commented lines and replace with a placeholder
        const commentPlaceholders = {};
        let placeholderIndex = 0;
        body = body.replace(/\/\/.*$/gm, (match) => {
            const placeholder = `__COMMENT_PLACEHOLDER_${placeholderIndex}__`;
            commentPlaceholders[placeholder] = match;
            placeholderIndex++;
            return placeholder;
        });

        // Replace common patterns
        
        code = body.replace(/for \((let|var) (\w+) = ([^;]+); ([^;]+); ([^\)]+)\)/gm, 'for (var $2 = $3; $4; $5)');

        const stringPlaceholders = {};
        let stringPlaceholderIndex = 0;
        code = code.replace(/('|"|`)([\s\S]*?)\1/gm, (match) => {
            const placeholder = `__CODE_PLACEHOLDER_${stringPlaceholderIndex}__`;

            stringPlaceholders[placeholder] = match.substring(1,match.length-1);
            stringPlaceholderIndex++;
            return placeholder;
        });


        //code = code.replace(/const/g, 'let');
        code = code.replace(/const (\w+) = (?!(vec\d+|mat\d+|\[.*|array))/gm, 'let $1 = ')

        const vecMatDeclarationRegex = /(let|var) (\w+) = (vec\d+|mat\d+)/gm;
        code = code.replace(vecMatDeclarationRegex, 'var $2 = $3');
        const vecMatDeclarationRegex2 = /const (\w+) = (vec\d+|mat\d+)/gm;
        code = code.replace(vecMatDeclarationRegex2, 'const $2 = $3');

        // ------ Array conversion ------ ------ ------ ------ ------ ------ ------

        // Extract array variable names
        const arrayVars = [] as any[];
        code.replace(/(let|var|const) (\w+) = (array|\[)/gm, (match, p1, varName) => {
            arrayVars.push(varName);
            return match; // Just to keep the replace function working
        });

        if (shaderType !== 'vertex' && shaderType !== 'fragment') {
            code = code.replace(/(\w+)\[([\w\s+\-*\/]+)\]/gm, (match, p1, p2) => {
                if (arrayVars.includes(p1)) return match;  // if the variable is an array declaration, return it as is
                return `${p1}.values[${p2}]`;
            });
        } else {
            // When shaderType is vertex or fragment, exclude specific variable names from the replacement
            code = code.replace(/(position|vertex|color|normal|uv)|(\w+)\[([\w\s+\-*\/]+)\]/gm, (match, p1, p2, p3) => {
                if (p1 || arrayVars.includes(p2)) return match;  // if match is one of the keywords or is an array variable, return it as is
                return `${p2}.values[${p3}]`;  // otherwise, apply the transformation
            });
        }
        
        code = code.replace(/(\w+)\.length/gm, 'arrayLength(&$1.values)');


        code = code.replace(/(\/\/[^\n]*);/gm, '$1'); //trim off semicolons after comments

        // Convert arrays with explicit values (like let a = [1,2,3];)
        code = code.replace(/(let|var|const) (\w+) = \[([\s\S]*?)\];/gm, (match, varType, varName, values) => {
            const valuesLines = values.trim().split('\n');
            const vals = [] as any[];
            const cleanedValues = valuesLines.map(line => {
                let cleaned = line.substring(0,line.indexOf('//') > 0 ? line.indexOf('//') : undefined); // remove inline comments
                cleaned = cleaned.substring(0,line.indexOf('__CO') > 0 ? line.indexOf('__COMM') : undefined); // remove COMMENT_PLACEHOLDER
                vals.push(line);
                return cleaned?.indexOf(',') < 0 ? cleaned + ',' : cleaned; // append comma for the next value
            }).join('\n');

            const valuesWithoutComments = cleanedValues.replace(/\/\*.*?\*\//gm, '').trim(); // remove multi-line comments
            const valuesArray = this.splitIgnoringBrackets(valuesWithoutComments);
            const size = valuesArray.length;

            const hasDecimal = valuesWithoutComments.includes('.');
            const isVecWithF = /^vec\d+f/.test(valuesWithoutComments);
            const inferredType = (valuesWithoutComments.startsWith('mat') || hasDecimal || isVecWithF) ? 'f32' : 'i32';

            // Extract the type from the first value (assumes all values in the array are of the same type)
            let arrayValueType = inferredType;
            const arrayValueTypeMatch = valuesWithoutComments.match(/^(vec\d+f?|mat\d+x\d+)/gm);
            if (arrayValueTypeMatch) {
                arrayValueType = arrayValueTypeMatch[0];
            }

            return `${varType} ${varName} : array<${arrayValueType}, ${size}> = array<${arrayValueType}, ${size}>(\n${vals.join('\n')}\n);`;
        });

        function transformArrays(input) {
            let lines = input.split('\n');
            let output = [] as any[];

            function countCharacter(str, char) {
                return str.split(char).length - 1;
            }

            function extractFillValue(line) {
                let startIndex = line.indexOf('.fill(') + 6;
                let parenthesesCount = 1;
                let endIndex = startIndex;

                while (parenthesesCount !== 0 && endIndex < line.length) {
                    endIndex++;
                    if (line[endIndex] === '(') {
                        parenthesesCount++;
                    } else if (line[endIndex] === ')') {
                        parenthesesCount--;
                    }
                }

                return line.substring(startIndex, endIndex);
            }

            for (let line of lines) {
                line = line.trim();
                let transformedLine = line;

                if (/^(let|const|var)\s/.test(line) && line.includes('.fill(')) {
                    let variableName = line.split('=')[0].trim().split(' ')[1];
                    let size = line.split('new Array(')[1].split(')')[0].trim();
                    let fillValue = extractFillValue(line);

                    let sizeCount = countCharacter(size, '(') - countCharacter(size, ')');
                    for (let i = 0; i < sizeCount; i++) size += ')';

                    if (fillValue.startsWith('vec')) {
                        let isVecWithF = /vec\d+f/.test(fillValue);
                        let vecType = isVecWithF || fillValue.match(/\.\d+/) ? 'f32' : 'i32'; // Check for decimals
                        transformedLine = `var ${variableName} : array<${fillValue.split('(')[0]}<${vecType}>, ${size}>;\n` +
                                        `for (var i: i32 = 0; i < ${size}; i = i + 1) {\n` +
                                        `\t${variableName}[i] = ${fillValue.replace(fillValue.split('(')[0], fillValue.split('(')[0] + `<${vecType}>`)};\n}`;
                    } else if (fillValue.startsWith('mat')) {
                        transformedLine = `var ${variableName} : array<${fillValue.split('(')[0]}<f32>, ${size}>;\n` +
                                        `for (var i: i32 = 0; i < ${size}; i = i + 1) {\n` +
                                        `\t${variableName}[i] = ${fillValue.replace(/vec(\d)/g, 'vec$1<f32>')};\n}`;
                    } else {
                        transformedLine = `var ${variableName} : array<f32, ${size}>;\n` +
                                        `for (var i: i32 = 0; i < ${size}; i = i + 1) {\n` +
                                        `\t${variableName}[i] = ${fillValue};\n}`;
                    }
                }

                output.push(transformedLine);
            }
            
            return output.join('\n');
        }


        code = transformArrays(code);

        code = code.replace(/(let|var|const) (\w+) = new (Float|Int|UInt)(\d+)Array\((\d+)\);/gm, (match, keyword, varName, typePrefix, bitSize, arraySize) => {
            let typeChar;
            switch(typePrefix) {
                case 'Float': 
                    typeChar = 'f';
                    break;
                case 'Int': 
                    typeChar = 'i';
                    break;
                case 'UInt': 
                    typeChar = 'u';
                    break;
                default: 
                    typeChar = 'f'; // defaulting to int
            }
            return `var ${varName} : array<${typeChar}${bitSize}, ${arraySize}>;`;
        });

        // Convert new Arrays with explicit sizes last
        code = code.replace(/(let|var|const) (\w+) = new Array\((\d+)\);/gm, 'var $2 : array<f32, $2>;');

        // ------ ------ ------ ------ ------ ------ ------ ------ ------ ------

        // Handle mathematical operations
        code = replaceJSFunctions(code, replacements);

        // Handle vector and matrix creation
        const vecMatCreationRegex = /(vec(\d+)|mat(\d+))\(([^)]+)\)/gm;
        code = code.replace(vecMatCreationRegex, (match, type, vecSize, matSize, args) => {
            // Split the arguments and check if any of them contain a decimal point
            const argArray = args.split(',').map(arg => arg.trim());
            const hasDecimal = argArray.some(arg => arg.includes('.'));
            
            const isVecWithF = /^vec\d+f/.test(type);
            // If any argument has a decimal, it's a float, otherwise it's an integer
            const inferredType = (type.startsWith('mat') || isVecWithF || hasDecimal) ? 'f32' : 'i32';
            
            if (type.startsWith('mat')) {
                // Always set internal vecs of mats to f32
                return `${type}<f32>(${argArray.join(', ').replace(/vec(\d+)/gm, 'vec$1<f32>')})`;
            } else {
                return `${type}<${inferredType}>(${argArray.join(', ')})`;
            }
        });

        
        params.forEach((param) => {
            if(param.isUniform) {
                const regex = new RegExp(`(?<![a-zA-Z0-9])${param.name}(?![a-zA-Z0-9])`, 'gm');
                code = code.replace(regex, `uniforms.${param.name}`);
            }
        });

        Object.keys(this.builtInUniforms).forEach((param) => {
            const regex = new RegExp(`(?<![a-zA-Z0-9])${param}(?![a-zA-Z0-9])`, 'gm');
            code = code.replace(regex, `defaults.${param}`);
        });

        // Replace placeholders with their corresponding comments
        for (const [placeholder, comment] of Object.entries(commentPlaceholders)) {
            code = code.replace(placeholder, comment as any);
        }
        for (const [placeholder, str] of Object.entries(stringPlaceholders)) {
            code = code.replace(placeholder, str as any);
        }
        
        //Vertex and Fragment shader transpiler (with some assumptions we made)
        // Extract variable names from the Vertex struct definition
        if(shaderType === 'fragment' || shaderType === 'vertex') {
            const vertexVarMatches = shaderHead.match(/@location\(\d+\) (\w+):/gm);
            const vertexVars = vertexVarMatches ? vertexVarMatches.map(match => {
                const parts = match.split(' ');
                return parts[1].replace(':', ''); // remove the colon
            }) : [];
            vertexVars.push('position');

            // Replace variables without pixel prefix with pixel prefixed version
            vertexVars.forEach(varName => {
                if(!varName.includes('In')) {
                    const regex = new RegExp(`(?<![a-zA-Z0-9_.])${varName}(?![a-zA-Z0-9_.])`, 'gm');
                    code = code.replace(regex, `pixel.${varName}`);
                }
            });
        }


        // ------ ------ ------ ------ ------ ------ ------ ------ ------ ------

        // Ensure lines not ending with a semicolon or open bracket have a semicolon appended. Not sure if this is stable
        code = code.replace(/^(.*[^;\s\{\[\(\,\>\}])(\s*\/\/.*)$/gm, '$1;$2');
        code = code.replace(/^(.*[^;\s\{\[\(\,\>\}])(?!\s*\/\/)(?=\s*$)/gm, '$1;');
        //trim off some cases for inserting semicolons wrong
        code = code.replace(/(\/\/[^\n]*);/gm, '$1'); //trim off semicolons after comments
        code = code.replace(/;([^\n]*)\s*(\n\s*)\)/gm, '$1$2)');

        let consts;
        if(extractConsts) {
            function extrConsts(text) {
                const pattern = /const\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[a-zA-Z_][a-zA-Z0-9_<>,\s]*\s*=\s*[a-zA-Z_][a-zA-Z0-9_<>,\s]*(\([\s\S]*?\)|\d+\.?\d*);/gm;

                let match;
                const extractedConsts = [] as any[];

                while ((match = pattern.exec(text)) !== null) {
                    extractedConsts.push(match[0]);
                }

                const pattern2 = /const\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\([\s\S]*?\)\s*;/gm;

                while ((match = pattern2.exec(text)) !== null) {
                    extractedConsts.push(match[0]);
                }

                const modifiedText = text.replace(pattern, '').replace(pattern2,'').trim();

                return {
                    consts:extractedConsts,
                    code:modifiedText
                };
            }
            
            
            //we will move these to outside the function loop to speed things up
            let extracted = extrConsts(code);
            code = extracted.code;
            consts = extracted.consts;
        }

        if(!returns) code = code.replace(/(return [^;]+;)/gm, '//$1');

        return {code, consts};
    }

    static indentCode(code) {
        let depth = 0;
        const tab = '    ';  // 4 spaces for indentation, can be adjusted
        let result = '';
        let needsIndent = false;
        let leadingSpaceDetected = false;
    
        for (let i = 0; i < code.length; i++) {
            const char = code[i];
    
            // If a newline is detected, set the flag to true to apply indentation
            if (char === '\n') {
                result += char;
                needsIndent = true;
                leadingSpaceDetected = false;
                continue;
            }
    
            // Check if there's leading space
            if (char === ' ' && needsIndent) {
                leadingSpaceDetected = true;
            }
    
            // Apply the necessary indentation if no leading space is detected
            if (needsIndent && !leadingSpaceDetected) {
                result += tab.repeat(depth);
                needsIndent = false;
            }
    
            // Increase the depth when an opening brace or parenthesis is detected
            if (char === '{' || char === '(') {
                depth++;
            }
    
            // Decrease the depth when a closing brace or parenthesis is detected
            if (char === '}' || char === ')') {
                if (depth > 0) depth--;
                if (result.slice(-tab.length) === tab) {
                    result = result.slice(0, -tab.length);
                }
            }
    
            result += char;
        }
    
        return result;
    }

    static addFunction = (
        func, 
        shaders
    ) => {
        if(!shaders.functions) shaders.functions = [] as any[];
        shaders.functions.push(func);
        for(const key of ['compute','fragment','vertex']) {
            if(shaders[key])
                Object.assign(shaders[key], this.convertToWebGPU(shaders[key].funcStr, key as any, shaders[key].bindGroupNumber, shaders[key].nVertexBuffers, shaders[key].workGroupSize ? shaders[key].workGroupSize : undefined, shaders.functions)); 
        }
        return shaders;
    }

    //combine input bindings and create mappings so input arrays can be shared based on variable names, assuming same types in a continuous pipeline (the normal thing)
    static combineBindings(bindings1str:string, bindings2str:string) {
        const bindingRegex = /@group\((\d+)\) @binding\((\d+)\)\s+(var(?:<[^>]+>)?)\s+(\w+)\s*:/g;
        const structRegex = /struct (\w+) \{([\s\S]*?)\}/;

        const combinedStructs = new Map();
        const replacementsOriginal = new Map();
        const replacementsReplacement = new Map();

        let changesShader1 = {};
        let changesShader2 = {};
        
        // Extract used group-binding pairs from the first shader
        let usedBindings = new Set();
        let bmatch;
        while ((bmatch = bindingRegex.exec(bindings1str)) !== null) {
            usedBindings.add(`${bmatch[1]}-${bmatch[2]}`);
        }

        // Adjust bindings in the second shader
        bindings2str = bindings2str.replace(bindingRegex, (match, group, binding, varDecl, varName) => {
            let newBinding = binding;
            while (usedBindings.has(`${group}-${newBinding}`)) {
                newBinding = (parseInt(newBinding) + 1).toString();
                changesShader2[varName] = { group: group, binding: newBinding };
            }
            usedBindings.add(`${group}-${newBinding}`);
            return `@group(${group}) @binding(${newBinding}) ${varDecl} ${varName}:`;
        });

        const extractBindings = (str, replacements, changes) => {
            let match;
            const regex = new RegExp(bindingRegex);
            while ((match = regex.exec(str)) !== null) {
                replacements.set(match[4], match[0].slice(0, match[0].indexOf(' var')));
                changes[match[4]] = {
                    group: match[1],
                    binding: match[2]
                };
                usedBindings.add(`${match[1]}-${match[2]}`);
            }
        };

        extractBindings(bindings1str, replacementsOriginal, changesShader1);
        extractBindings(bindings2str, replacementsReplacement, changesShader2);


        // Combine structs and ensure no duplicate fields
        let match = structRegex.exec(bindings1str);
        if (match) {
            const fields = match[2].trim().split(',\n').map(field => field.trim());
            combinedStructs.set(match[1], fields);
        }
        match = structRegex.exec(bindings2str);
        if (match) {
            const fields = match[2].trim().split(',\n').map(field => field.trim());
            const existing = combinedStructs.get(match[1]) || [];
            fields.forEach(field => {
                const fieldName = field.split(':')[0].trim();
                if (!existing.some(e => e.startsWith(fieldName))) {
                    existing.push(field);
                }
            });
            combinedStructs.set(match[1], existing);
        }

        const constructCombinedStruct = (structName) => {
            if (combinedStructs.has(structName)) {
                return `struct ${structName} {\n    ${combinedStructs.get(structName).join(',\n    ')}\n};\n`;
            }
            return '';
        };

        const result1 = bindings1str.replace(/struct UniformStruct \{[\s\S]*?\};/g, () => constructCombinedStruct('UniformStruct'))
        .replace(bindingRegex, match => {
            const varName = match.split(' ').pop().split(':')[0];
            if (replacementsReplacement.has(varName)) {
                const updated = replacementsOriginal.get(varName) + ' ' + match.split(' ').slice(-2).join(' ');
                const newGroup = (updated as any).match(/@group\((\d+)\)/)[1];
                const newBinding = (updated as any).match(/@binding\((\d+)\)/)[1];
                changesShader1[varName] = { group: newGroup, binding: newBinding };
                return updated;
            }
            return match;
        });

        const result2 = bindings2str.replace(/struct UniformStruct \{[\s\S]*?\};/g, () => constructCombinedStruct('UniformStruct'))
        .replace(bindingRegex, match => {
            const varName = match.split(' ').pop().split(':')[0];
            if (replacementsOriginal.has(varName)) {
                const updated = replacementsOriginal.get(varName) + ' ' + match.split(' ').slice(-2).join(' ');
                const newGroup = (updated as any).match(/@group\((\d+)\)/)[1];
                const newBinding = (updated as any).match(/@binding\((\d+)\)/)[1];
                changesShader2[varName] = { group: newGroup, binding: newBinding };
                return updated;
            }
            return match;
        });

        return {
            code1: result1.trim(),
            changes1: changesShader1 as any,
            code2: result2.trim(),
            changes2: changesShader2 as any
        };

        /*
                const originalBindings = `
                struct UniformStruct {
                    a: f32,
                    b: f32,
                    c: f32
                };
                @group(0) @binding(0) var texture1: texture_2d<f32>;
                @group(0) @binding(1) var texture2: sampler;
                `;

                const replacementBindings = `
                struct UniformStruct {
                    c: f32,
                    d: f32
                };
                @group(0) @binding(0) var arr0: array<f32> //this should be set to @binding(2) since it is the second one
                @group(1) @binding(0) var arr1: array<f32>;
                @group(1) @binding(1) var texture1: texture_2d<f32>;
                @group(1) @binding(2) var textureB: sampler;
                `;

                const combined = combineBindings(originalBindings, replacementBindings);
                console.log(combined.result1);
                console.log(combined.changes1);
                console.log(combined.result2);
                console.log(combined.changes2);
         * 
         * 
         * 
         */
    }

    static combineShaderParams (shader1Obj:TranspiledShader, shader2Obj:TranspiledShader) {
        let combinedAst = shader2Obj.ast ? [...shader2Obj.ast] : [] as any[]; // using spread syntax to clone
        let combinedParams = shader2Obj.params ? [...shader2Obj.params] : [] as any[];
        let combinedReturnedVars = [] as any[];

        const returnMatches = shader2Obj.funcStr.match(/^(?![ \t]*\/\/).*\breturn .*;/gm);
        if (returnMatches) {
            const returnedVars = returnMatches.map(match => match.replace(/^[ \t]*return /, '').replace(';', ''));
            combinedReturnedVars.push(...WGSLTranspiler.flattenStrings(returnedVars));
        }

        const returnMatches2 = shader1Obj.funcStr.match(/^(?![ \t]*\/\/).*\breturn .*;/gm);
        if (returnMatches2) {
            const returnedVars2 = returnMatches2.map(match => match.replace(/^[ \t]*return /, '').replace(';', ''));
            combinedReturnedVars.push(...WGSLTranspiler.flattenStrings(returnedVars2));
        }

        //we are combining vertex and frag shader inputs into one long array, and updating bindings to match sequential instantiation between the vertex and frag so the binding layouts match
        if (shader1Obj.ast) combinedAst.push(...shader1Obj.ast);
        if (shader1Obj.params) combinedParams.push(...shader1Obj.params);

        // Filter out duplicate bindings and re-index the remaining ones
        const uniqueBindings = new Set();
        const updatedParams = [] as any[];
        const bindingMap2 = new Map();  // Only for fragment shader

        // Shared bindings: Make fragment shader match vertex shader
        shader1Obj.params.forEach((entry,i) => {
            if (shader2Obj.params.some(param => param.name === entry.name) && !uniqueBindings.has(entry.name)) {
                uniqueBindings.add(entry.name);
                const newBinding = i; // Keep vertex shader binding
                updatedParams.push(entry);
                bindingMap2.set(entry.binding, newBinding);  // Map fragment shader's old binding to new
            }
        });

        let maxSharedBinding = uniqueBindings.size - 1;

        // Exclusive fragment shader bindings
        shader2Obj.params.forEach((entry,i) => {
            if (!shader1Obj.params.some(param => param.name === entry.name) && !uniqueBindings.has(entry.name)) {
                uniqueBindings.add(i);
                maxSharedBinding++;
                updatedParams.push(entry);
                bindingMap2.set(entry.binding, maxSharedBinding);
            }
        });

        combinedParams = updatedParams;

        // Only update binding numbers in the shader code for fragment shader using bindingMap2
        let shaderCode2 = shader2Obj.code;
        for (let [oldBinding, newBinding] of bindingMap2.entries()) {
            const regex = new RegExp(`@binding\\(${oldBinding}\\)`, 'g');
            shaderCode2 = shaderCode2.replace(regex, `@binding(${newBinding})`);
        }
        shader2Obj.code = shaderCode2;
        shader1Obj.ast = combinedAst;
        (shader1Obj as any).returnedVars = combinedReturnedVars;
        shader1Obj.params = combinedParams;

        shader2Obj.ast = combinedAst;
        (shader2Obj as any).returnedVars = combinedReturnedVars;
        shader2Obj.params = combinedParams;
    }

    //this pipeline is set to only use javascript functions so it can generate asts and infer all of the necessary buffering orders and types
    static convertToWebGPU(
        func:Function|string,  
        shaderType:'compute'|'vertex'|'fragment'='compute', 
        bindGroupNumber=0, 
        nVertexBuffers=1, 
        workGroupSize=256, 
        gpuFuncs?:(Function|string)[],
        variableTypes?:{[key:string]:string|{binding:string}},
        lastBinding=0
    ) { //use compute shaders for geometry shaders
        let funcStr = typeof func === 'string' ? func : func.toString();
        funcStr = funcStr.replace(/(?<!\w)this\./g, '');
        const tokens = this.tokenize(funcStr);
        const ast = this.parse(funcStr, tokens, shaderType);
        //console.log(ast);
        let webGPUCode = this.generateDataStructures(
            funcStr, 
            ast, 
            bindGroupNumber, 
            shaderType, 
            variableTypes, 
            lastBinding
        ); //simply share bindGroups 0 and 1 between compute and render

        const header = webGPUCode.code;
        webGPUCode.code += '\n' + this.generateMainFunctionWorkGroup(
            funcStr, 
            ast, 
            webGPUCode.params, 
            shaderType, 
            nVertexBuffers, 
            workGroupSize, 
            gpuFuncs
        ); // Pass funcStr as the first argument

        return {
            code:this.indentCode(webGPUCode.code), 
            header, 
            ast, 
            params:webGPUCode.params, 
            funcStr, 
            defaultUniforms:webGPUCode.defaultUniforms, 
            type:shaderType,
            workGroupSize:shaderType === 'compute' ? workGroupSize : undefined,
            bindGroupNumber,
            lastBinding:webGPUCode.lastBinding
        } as TranspiledShader;
    }


}


function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function replaceJSFunctions(code, replacements) {
    for (let [jsFunc, shaderFunc] of Object.entries(replacements)) {
        const regex = new RegExp(jsFunc.replace('.', '\\.'), 'g'); // Escape dots for regex
        code = code.replace(regex, shaderFunc);
    }
    return code;
}


// Usage: replace javascript functions or constants with their WGSL equivalent. Note you can also just call any WGSL function without the javascript equivalent existing as nothing executs in JS
export const replacements = {
    'Math.PI': `${Math.PI}`,
    'Math.E':  `${Math.E}`,
    'Math.abs': 'abs',
    'Math.acos': 'acos',
    'Math.asin': 'asin',
    'Math.atan': 'atan',
    'Math.atan2': 'atan2', // Note: Shader might handle atan2 differently, ensure compatibility
    'Math.ceil': 'ceil',
    'Math.cos': 'cos',
    'Math.exp': 'exp',
    'Math.floor': 'floor',
    'Math.log': 'log',
    'Math.max': 'max',
    'Math.min': 'min',
    'Math.pow': 'pow',
    'Math.round': 'round',
    'Math.sin': 'sin',
    'Math.sqrt': 'sqrt',
    'Math.tan': 'tan',
    // ... add more replacements as needed
};

const wgslTypeSizes32 = {
    'bool':{ alignment: 1, size: 1 },
    'u8':  { alignment: 1, size: 1 },
    'i8':  { alignment: 1, size: 1 },
    'i32': { alignment: 4, size: 4 },
    'u32': { alignment: 4, size: 4 },
    'f32': { alignment: 4, size: 4 },
    'i64': { alignment: 8, size: 8 },
    'u64': { alignment: 8, size: 8 },
    'f64': { alignment: 8, size: 8 },
    'atomic': { alignment: 4, size: 4 },
    'vec2<f32>': { alignment: 8, size: 8 },
    'vec2f': { alignment: 8, size: 8 },
    'vec2<i32>': { alignment: 8, size: 8 },
    'vec2<u32>': { alignment: 8, size: 8 },
    'vec3<f32>': { alignment: 16, size: 12 },
    'vec3f': { alignment: 16, size: 12 },
    'vec3<i32>': { alignment: 16, size: 12 },
    'vec3<u32>': { alignment: 16, size: 12 },
    'vec4<f32>': { alignment: 16, size: 16 },
    'vec4f': { alignment: 16, size: 16 },
    'vec4<i32>': { alignment: 16, size: 16 },
    'vec4<u32>': { alignment: 16, size: 16 },
    'mat2x2<f32>': { alignment: 8, size: 16 },
    'mat2x2<i32>': { alignment: 8, size: 16 },
    'mat2x2<u32>': { alignment: 8, size: 16 },
    'mat3x2<f32>': { alignment: 8, size: 24 },
    'mat3x2<i32>': { alignment: 8, size: 24 },
    'mat3x2<u32>': { alignment: 8, size: 24 },
    'mat4x2<f32>': { alignment: 8, size: 32 },
    'mat4x2<i32>': { alignment: 8, size: 32 },
    'mat4x2<u32>': { alignment: 8, size: 32 },
    'mat2x3<f32>': { alignment: 16, size: 32 },
    'mat2x3<i32>': { alignment: 16, size: 32 },
    'mat2x3<u32>': { alignment: 16, size: 32 },
    'mat3x3<f32>': { alignment: 16, size: 48 },
    'mat3x3<i32>': { alignment: 16, size: 48 },
    'mat3x3<u32>': { alignment: 16, size: 48 },
    'mat4x3<f32>': { alignment: 16, size: 64 },
    'mat4x3<i32>': { alignment: 16, size: 64 },
    'mat4x3<u32>': { alignment: 16, size: 64 },
    'mat2x4<f32>': { alignment: 16, size: 32 },
    'mat2x4<i32>': { alignment: 16, size: 32 },
    'mat2x4<u32>': { alignment: 16, size: 32 },
    'mat3x4<f32>': { alignment: 16, size: 48 },
    'mat3x4<i32>': { alignment: 16, size: 48 },
    'mat3x4<u32>': { alignment: 16, size: 48 },
    'mat4x4<f32>': { alignment: 16, size: 64 },
    'mat4x4<i32>': { alignment: 16, size: 64 },
    'mat4x4<u32>': { alignment: 16, size: 64 }
};

const wgslTypeSizes16 = {
    'i16': { alignment: 2, size: 2 }, //and we can do these
    'u16': { alignment: 2, size: 2 }, //we can do these in javascript
    'f16': { alignment: 2, size: 2 },
    'vec2<f16>': { alignment: 4, size: 4 },
    'vec2<i16>': { alignment: 4, size: 4 },
    'vec2<u16>': { alignment: 4, size: 4 },
    'vec3<f16>': { alignment: 8, size: 6 },
    'vec3<i16>': { alignment: 8, size: 6 },
    'vec3<u16>': { alignment: 8, size: 6 },
    'vec4<f16>': { alignment: 8, size: 8 },
    'vec4<i16>': { alignment: 8, size: 8 },
    'vec4<u16>': { alignment: 8, size: 8 },
    'mat2x2<f16>': { alignment: 4, size: 8 }, //only f is actually supported in webgpu rn afaik
    'mat2x2<i16>': { alignment: 4, size: 8 },
    'mat2x2<u16>': { alignment: 4, size: 8 },
    'mat3x2<f16>': { alignment: 4, size: 12 },
    'mat3x2<i16>': { alignment: 4, size: 12 },
    'mat3x2<u16>': { alignment: 4, size: 12 },
    'mat4x2<f16>': { alignment: 4, size: 16 },
    'mat4x2<i16>': { alignment: 4, size: 16 },
    'mat4x2<u16>': { alignment: 4, size: 16 },
    'mat2x3<f16>': { alignment: 8, size: 16 },
    'mat2x3<i16>': { alignment: 8, size: 16 },
    'mat2x3<u16>': { alignment: 8, size: 16 },
    'mat3x3<f16>': { alignment: 8, size: 24 },
    'mat3x3<i16>': { alignment: 8, size: 24 },
    'mat3x3<u16>': { alignment: 8, size: 24 },
    'mat4x3<f16>': { alignment: 8, size: 32 },
    'mat4x3<i16>': { alignment: 8, size: 32 },
    'mat4x3<u16>': { alignment: 8, size: 32 },
    'mat2x4<f16>': { alignment: 8, size: 16 },
    'mat2x4<i16>': { alignment: 8, size: 16 },
    'mat2x4<u16>': { alignment: 8, size: 16 },
    'mat3x4<f16>': { alignment: 8, size: 24 },
    'mat3x4<i16>': { alignment: 8, size: 24 },
    'mat3x4<u16>': { alignment: 8, size: 24 },
    'mat4x4<f16>': { alignment: 8, size: 32 },
    'mat4x4<i16>': { alignment: 8, size: 32 }, 
    'mat4x4<u16>': { alignment: 8, size: 32 }
};



export const textureFormats = [ //https://www.w3.org/TR/webgpu/#texture-formats
    // 8-bit formats
    "r8unorm",
    "r8snorm",
    "r8uint",
    "r8sint",

    // 16-bit formats
    "r16uint",
    "r16sint",
    "r16float",
    "rg8unorm",
    "rg8snorm",
    "rg8uint",
    "rg8sint",

    // 32-bit formats
    "r32uint",
    "r32sint",
    "r32float",
    "rg16uint",
    "rg16sint",
    "rg16float",
    "rgba8unorm",
    "rgba8unorm-srgb",
    "rgba8snorm",
    "rgba8uint",
    "rgba8sint",
    "bgra8unorm",
    "bgra8unorm-srgb",

    // Packed 32-bit formats
    "rgb9e5ufloat",
    "rgb10a2uint",
    "rgb10a2unorm",
    "rg11b10ufloat",

    // 64-bit formats
    "rg32uint",
    "rg32sint",
    "rg32float",
    "rgba16uint",
    "rgba16sint",
    "rgba16float",

    // 128-bit formats
    "rgba32uint",
    "rgba32sint",
    "rgba32float",

    // Depth/stencil formats
    "stencil8",
    "depth16unorm",
    "depth24plus",
    "depth24plus-stencil8",
    "depth32float",

    // "depth32float-stencil8" feature
    "depth32float-stencil8",

    // BC compressed formats usable if "texture-compression-bc" is both
    // supported by the device/user agent and enabled in requestDevice.
    "bc1-rgba-unorm",
    "bc1-rgba-unorm-srgb",
    "bc2-rgba-unorm",
    "bc2-rgba-unorm-srgb",
    "bc3-rgba-unorm",
    "bc3-rgba-unorm-srgb",
    "bc4-r-unorm",
    "bc4-r-snorm",
    "bc5-rg-unorm",
    "bc5-rg-snorm",
    "bc6h-rgb-ufloat",
    "bc6h-rgb-float",
    "bc7-rgba-unorm",
    "bc7-rgba-unorm-srgb",

    // ETC2 compressed formats usable if "texture-compression-etc2" is both
    // supported by the device/user agent and enabled in requestDevice.
    "etc2-rgb8unorm",
    "etc2-rgb8unorm-srgb",
    "etc2-rgb8a1unorm",
    "etc2-rgb8a1unorm-srgb",
    "etc2-rgba8unorm",
    "etc2-rgba8unorm-srgb",
    "eac-r11unorm",
    "eac-r11snorm",
    "eac-rg11unorm",
    "eac-rg11snorm",

    // ASTC compressed formats usable if "texture-compression-astc" is both
    // supported by the device/user agent and enabled in requestDevice.
    "astc-4x4-unorm",
    "astc-4x4-unorm-srgb",
    "astc-5x4-unorm",
    "astc-5x4-unorm-srgb",
    "astc-5x5-unorm",
    "astc-5x5-unorm-srgb",
    "astc-6x5-unorm",
    "astc-6x5-unorm-srgb",
    "astc-6x6-unorm",
    "astc-6x6-unorm-srgb",
    "astc-8x5-unorm",
    "astc-8x5-unorm-srgb",
    "astc-8x6-unorm",
    "astc-8x6-unorm-srgb",
    "astc-8x8-unorm",
    "astc-8x8-unorm-srgb",
    "astc-10x5-unorm",
    "astc-10x5-unorm-srgb",
    "astc-10x6-unorm",
    "astc-10x6-unorm-srgb",
    "astc-10x8-unorm",
    "astc-10x8-unorm-srgb",
    "astc-10x10-unorm",
    "astc-10x10-unorm-srgb",
    "astc-12x10-unorm",
    "astc-12x10-unorm-srgb",
    "astc-12x12-unorm",
    "astc-12x12-unorm-srgb",
];

//IDK if this is correct but it mostly depends
export const imageToTextureFormats = {
    ".png": [
        "r8unorm", 
        "rg8unorm", 
        "rgba8unorm", 
        "rgba8unorm-srgb", 
        "rgb10a2unorm", 
        "bgra8unorm", 
        "bgra8unorm-srgb"
    ],
    ".jpg": [
        "r8unorm", 
        "rg8unorm", 
        "rgba8unorm", 
        "rgba8unorm-srgb", 
        "rgb10a2unorm", 
        "bgra8unorm", 
        "bgra8unorm-srgb"
    ],
    ".hdr": [
        "r16float", 
        "rg16float", 
        "rgba16float"
    ],
    ".exr": [
        "r32float", 
        "rg32float", 
        "rgba32float"
    ]
};

export const WGSLTypeSizes = Object.assign({}, wgslTypeSizes16, wgslTypeSizes32);


for (const [key, value] of Object.entries(WGSLTypeSizes)) {
    WGSLTypeSizes[key] = { ...value, type: key };
}
