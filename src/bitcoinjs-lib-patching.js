var assert = require('assert')

var bitcoin = require('bitcoinjs-lib')
var Address = bitcoin.Address
var ECPubKey = bitcoin.ECPubKey
var bufferutils = bitcoin.bufferutils
var scripts = bitcoin.scripts
var opcodes = bitcoin.opcodes


/**
 * Extract from obsolete pay-to-pubkey transaction
 *
 * I try added to bitcoinjs-lib, but got circular require:
 *  https://github.com/bitcoinjs/bitcoinjs-lib/pull/273
 */
bitcoin.Address.fromOutputScript = function(script, network) {
  var scriptType = scripts.classifyOutput(script)

  if (scriptType === 'pubkeyhash')
    return new Address(script.chunks[2], network.pubKeyHash).toBase58Check()

  if (scriptType === 'scripthash')
    return new Address(script.chunks[1], network.scriptHash).toBase58Check()

  if (scriptType === 'pubkey')
    return ECPubKey.fromBuffer(script.chunks[0]).getAddress(network).toBase58Check()
    
  return null
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} size
 * @return {Buffer}
 */
function sliceAndFill(buffer, offset, size) {
  var bytes = Array.apply(null, Array(size)).map(function(){ return 0 })
  var buf = Buffer.concat([buffer.slice(offset+1), new Buffer(bytes)])
  return buf
}

/**
 * Input script invalid
 *
 * Example:
 *  tx: b538afeb33dc482af0c2dfd33a0365ce1198e68355dd2022355a55840c59f545
 *  script: 03ec92000450ab31ff4e070000
 */
bufferutils.readPushDataInt = function(buffer, offset) {
  var opcode = buffer.readUInt8(offset)
  var number, size

  // ~6 bit
  if (opcode < opcodes.OP_PUSHDATA1) {
    number = opcode
    size = 1

  // 8 bit
  } else if (opcode === opcodes.OP_PUSHDATA1) {
    if (offset+1 < buffer.length)
      number = buffer.readUInt8(offset + 1)
    else
      number = sliceAndFill(buffer, offset+1, 1).readUInt8(0)

    size = 2

  // 16 bit
  } else if (opcode === opcodes.OP_PUSHDATA2) {
    if (offset+3 < buffer.length)
      number = buffer.readUInt16LE(offset + 1)
    else
      number = sliceAndFill(buffer, offset+1, 2).readUInt16LE(0)

    size = 3

  // 32 bit
  } else {
    assert.equal(opcode, opcodes.OP_PUSHDATA4, 'Unexpected opcode')

    if (offset+5 < buffer.length)
      number = buffer.readUInt32LE(offset + 1)
    else
      number = sliceAndFill(buffer, offset+1, 4).readUInt32LE(0)

    size = 5
  }

  return {
    opcode: opcode,
    number: number,
    size: size
  }
}
