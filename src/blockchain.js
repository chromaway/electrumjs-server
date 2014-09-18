var events = require('events')
var inherits = require('util').inherits

var config = require('config')
var bitcoind = require('bitcoin')
var bitcoin = require('bitcoinjs-lib')
var bufferEqual = require('buffer-equal')
var _ = require('lodash')
var Q = require('q')

var networks = require('./networks')
var util = require('./util')


/**
 * @param {bitcoin.Client} bitcoinClient
 * @param {string} blockHash
 * @return {Q.Promise}
 */
function getFullBlock(bitcoinClient, blockHash) {
  return Q.ninvoke(bitcoinClient, 'cmd', 'getblock', blockHash).spread(function(block) {
    if (block.height === 0) {
      block.tx = []
      block.previousblockhash = '0000000000000000000000000000000000000000000000000000000000000000'
      return block
    }

    return Q.Promise(function(resolve, reject) {
      var batch = block.tx.map(function(txId) {
        return { method: 'getrawtransaction', params: [txId] }
      })

      var resultTx = []
      function callback(error, rawTx) {
        if (error) {
          reject(error)
          return
        }

        resultTx.push(bitcoin.Transaction.fromHex(rawTx))
        if (resultTx.length === batch.length) {
          block.tx = resultTx
          resolve(block)
        }
      }

      bitcoinClient.cmd(batch, callback)
    })
  })
}


/**
 * @event Blockchain#newHeight
 */

/**
 * @event Blockchain#touchedAddress
 * @type {string}
 */

/**
 * @class Blockchain
 */
function Blockchain() {
  events.EventEmitter.call(this)

  this._isInialized = false
}

inherits(Blockchain, events.EventEmitter)

/**
 * @return {Q.Promise}
 */
Blockchain.prototype.initialize = function() {
  var self = this
  if (self._isInialized)
    return Q()

  self._isInialized = true

  var deferred = Q.defer()
  Q.spawn(function* () {
    try {
      self.network = networks[config.get('server.network')]
      if (_.isUndefined(self.network))
        throw new Error('Unknow server.network: ' + config.get('server.network'))

      /** create bitcoind client and check network */
      self.bitcoindClient = new bitcoind.Client({
        host: config.get('bitcoind.host'),
        port: config.get('bitcoind.port'),
        user: config.get('bitcoind.user'),
        pass: config.get('bitcoind.password')
      })
      self.bitcoind = Q.nbind(self.bitcoindClient.cmd, self.bitcoindClient)

      var bitcoindInfo = (yield self.bitcoind('getinfo'))[0]
      if (config.get('server.network') === 'testnet' && !bitcoindInfo.testnet)
        throw new Error('bitcoind and ewallet-server have different networks')

      /** create storage */
      switch (config.get('server.storage')) {
        case 'mongo':
          var MongoStorage = require('./storage/mongo')
          self.storage = new MongoStorage()
          break

        case 'postgres':
          var PostgresStorage = require('./storage/postgres')
          self.storage = new PostgresStorage()
          break

        case 'redis':
          var RedisStorage = require('./storage/redis')
          self.storage = new RedisStorage()
          break

        default:
          throw new Error('Unknow storage: ', config.get('server.storage'))
      }
      yield self.storage.initialize()

      /** load headers and set last block hash */
      self.chunksCache = []

      var headers = yield self.storage.getAllHeaders()
      headers.forEach(self.pushHeader.bind(self))

      self.updateLastBlockHash()

      /** sync storage with bitcoind */
      yield self.catchUp()
      /** catch up new blocks and get info from mempool */
      self.mempool = { txIds: {}, spent: {}, addrs: {}, coins: {} }
      self.on('newHeight', function() {
        console.log('clear mempool')
        self.mempool = { txIds: {}, spent: {}, addrs: {}, coins: {} }
      })
      process.nextTick(self.mainIteration.bind(self))

      /** done */
      console.log('Blockchain ready, current height: ', self.getBlockCount() - 1)
      deferred.resolve()

    } catch (error) {
      deferred.reject(error)

    }
  })

  return deferred.promise
}

/**
 * @param {string} header
 */
Blockchain.prototype.pushHeader = function(hexHeader) {
  /** update chunks (2016 headers include) */
  if (this.chunksCache.length === 0) {
    this.chunksCache[0] = hexHeader
    return
  }

  if (this.chunksCache[this.chunksCache.length - 1].length === 322560) {
    this.chunksCache.push(hexHeader)
    return
  }

  this.chunksCache[this.chunksCache.length - 1] += hexHeader
}

/**
 */
Blockchain.prototype.popHeader = function() {
  /** update chunks */
  var lastChunkIndex = this.chunksCache.length - 1
  var lastChunk = this.chunksCache[lastChunkIndex]

  if (lastChunk.length === 160) {
    this.chunksCache.pop()
    return
  }

  this.chunksCache[lastChunkIndex] = lastChunk.slice(0, lastChunk.length - 160)
}

/**
 * @return {number}
 */
Blockchain.prototype.getBlockCount = function() {
  var chunksCacheLength = this.chunksCache.length
  return Math.max(0, chunksCacheLength-1) * 2016 + (this.chunksCache[chunksCacheLength-1] || '').length / 160
}

/**
 * @param {number} index
 * @return {string}
 * @throws {RangeError}
 */
Blockchain.prototype.getHeader = function(index) {
  var chunk = this.chunksCache[~~(index/2016)] || ''
  var header = chunk.slice((index % 2016)*160, (index % 2016 + 1)*160)
  if (header.length === 0)
    throw new RangeError('Header not exists')
  return header
}

/**
 * @param {number} index
 * @return {string}
 * @throws {RangeError}
 */
Blockchain.prototype.getChunk = function(index) {
  if (index < 0 || index >= this.chunksCache.length)
    throw new RangeError('Chunk not exists')

  return this.chunksCache[index]
}

/**
 */
Blockchain.prototype.updateLastBlockHash = function() {
  var lastBlockHash = '0000000000000000000000000000000000000000000000000000000000000000'

  if (this.getBlockCount() > 0) {
    var hexHeader = this.getHeader(this.getBlockCount() - 1)
    var rawHeader = new Buffer(hexHeader, 'hex')
    var headerHash = util.hash256(rawHeader)
    lastBlockHash = util.hashEncode(headerHash)
  }

  this.lastBlockHash = lastBlockHash
}

/**
 * Sync storage with bitcoind
 * @return {Q.Promise}
 */
Blockchain.prototype.catchUp = function() {
  var self = this

  return Q.Promise(function(resolve, reject) {
    Q.spawn(function* () {
      var sigintReceived = false
      function onSIGINT() { sigintReceived = true; console.log('SIGINT received, please wait...') }
      process.addListener('SIGINT', onSIGINT)

      try {
        while (!sigintReceived) {
          var blockCount = (yield self.bitcoind('getblockcount'))[0]
          var blockHash = (yield self.bitcoind('getblockhash', blockCount))[0]
          if (self.lastBlockHash === blockHash)
            break

          blockHash = (yield self.bitcoind('getblockhash', self.getBlockCount()))[0]
          var fullBlock = yield getFullBlock(self.bitcoindClient, blockHash)
          if (self.lastBlockHash === fullBlock.previousblockhash) {
            yield self.importBlock(fullBlock)

          } else {
            fullBlock = yield getFullBlock(self.bitcoindClient, self.lastBlockHash)
            yield self.importBlock(fullBlock, true)

          }

          self.emit('newHeight')
        }

        if (!sigintReceived)
          resolve()

      } catch (error) {
        if (!sigintReceived)
          reject(error)

      }

      process.removeListener('SIGINT', onSIGINT)
      if (sigintReceived)
        process.exit()
    })
  })
}

/**
 * @param {Object} block
 * @param {boolean} [revert=false]
 * @return {Q.Promise}
 */
Blockchain.prototype.importBlock = function(block, revert) {
  var self = this

  if (_.isUndefined(revert))
    revert = false

  var deferred = Q.defer()
  Q.spawn(function* () {
    try {
      var stat = {
        st: Date.now(),
        inputs: 0,
        outputs: 0,
        touchedAddress: new util.Set()
      }

      if (!revert) {
        var hexHeader = util.block2rawHeader(block).toString('hex')
        yield self.storage.pushHeader(hexHeader, block.height)
        self.pushHeader(hexHeader)

      } else {
        yield self.storage.popHeader()
        self.popHeader()

      }

      self.updateLastBlockHash()

      var address, inIndex, outIndex, input, cTxId
      var currentHeight = self.getBlockCount() - 1

      for (var txIndex = 0; txIndex < block.tx.length; ++txIndex) {
        var tx = block.tx[txIndex]
        var txId = tx.getId()

        stat.inputs += tx.ins.length
        stat.outputs += tx.outs.length

        if (!revert) {
          for (inIndex = 0; inIndex < tx.ins.length; ++inIndex) {
            input = tx.ins[inIndex]
            cTxId = util.hashEncode(input.hash)
            address = yield self.storage.getAddress(cTxId, input.index)
            if (address === null)
              continue

            yield self.storage.setSpent(cTxId, input.index, txId, currentHeight)
            stat.touchedAddress.add(address)
          }

          for (outIndex = 0; outIndex < tx.outs.length; ++outIndex) {
            var output = tx.outs[outIndex]
            address = bitcoin.Address.fromOutputScript(output.script, self.network)
            if (address === null)
              continue

            yield self.storage.addCoin(address, txId, outIndex, output.value, currentHeight)
            stat.touchedAddress.add(address)
          }
        } else {
          for (outIndex = 0; outIndex < tx.outs.length; ++outIndex) {
            address = yield self.storage.getAddress(txId, outIndex)
            if (address === null)
              continue

            yield self.storage.removeCoin(txId, outIndex)
            stat.touchedAddress.add(address)
          }

          for (inIndex = 0; inIndex < tx.ins.length; ++inIndex) {
            input = tx.ins[inIndex]
            cTxId = util.hashEncode(input.hash)
            address = yield self.storage.getAddress(cTxId, input.index)
            if (address === null)
              continue

            yield self.storage.setUnspent(txId, input.index)
            stat.touchedAddress.add(address)
          }
        }
      }

      /** done */
      var msg = [
        (revert ? 'revert' : 'import') + ' block #' + block.height,
        block.tx.length + ' transactions',
        stat.inputs + '/' + stat.outputs,
        (Date.now() - stat.st) + 'ms'
      ]
      console.log(msg.join(', '))
      stat.touchedAddress.get().forEach(function(addr) { self.emit('touchedAddress', addr) })
      deferred.resolve()

    } catch (error) {
      deferred.reject(error)

    }
  })
  return deferred.promise
}

/**
 * @return {Q.Promise}
 */
Blockchain.prototype.updateMempool = function() {
  var self = this

  /**
   * mempool structure
   *  txIds: {txId: true}
   *  spent: {cTxId: {cIndex: sTxId}}
   *  addrs: {sTxId+sIndex: address}
   *  coins: {address: {cTxId: {cIndex: cValue}}}
   */

  var deferred = Q.defer()
  Q.spawn(function* () {
    try {
      var stat = {
        st: Date.now(),
        added: 0,
        touchedAddress: new util.Set()
      }

      var mempoolTxIds = (yield self.bitcoind('getrawmempool'))[0]
      // need toposort?
      for (var mempoolTxIdsIndex = 0; mempoolTxIdsIndex < mempoolTxIds.length; ++mempoolTxIdsIndex) {
        var txId = mempoolTxIds[mempoolTxIdsIndex]
        if (self.mempool.txIds[txId] === true)
          continue

        self.mempool.txIds[txId] = true
        stat.added += 1

        var rawTx = (yield self.bitcoind('getrawtransaction', txId))[0]
        var tx = bitcoin.Transaction.fromHex(rawTx)

        tx.ins.forEach(function(input) {
          var cTxId = util.hashEncode(input.hash)
          var cIndex = input.index

          self.mempool.spent[cTxId] = self.mempool.spent[cTxId] || {}
          self.mempool.spent[cTxId][cIndex] = txId

          stat.touchedAddress.add([cTxId, cIndex].join(','))
        })

        tx.outs.forEach(function(output, outIndex) {
          var address = bitcoin.Address.fromOutputScript(output.script, self.network)
          if (address === null)
            return

          self.mempool.addrs[txId + outIndex] = address

          self.mempool.coins[address] = self.mempool.coins[address] || {}
          self.mempool.coins[address][txId] = self.mempool.coins[address][txId] || {}
          self.mempool.coins[address][txId][outIndex] = output.value

          stat.touchedAddress.add(address)
        })
      }

      var promises = []
      stat.touchedAddress.get().forEach(function(addr) {
        var items = addr.split(',')
        if (items.length === 1)
          return

        stat.touchedAddress.remove(addr)
        if (!_.isUndefined(self.mempool.addrs[addr])) {
          stat.touchedAddress.add(self.mempool.addrs[addr])
          return
        }

        promises.push(self.storage.getAddress(items[0], parseInt(items[1])).then(function(addr) {
          if (addr !== null)
            stat.touchedAddress.add(addr)
        }))
      })
      Q.all(promises).then(function() {
        stat.touchedAddress.get().forEach(function(addr) { self.emit('touchedAddress', addr) })
      })

      var msg = [
        'update mempool',
        '+' + stat.added,
        'now: ' + Object.keys(self.mempool.txIds).length,
        (Date.now() - stat.st) + 'ms'
      ]
      console.log(msg.join(', '))
      deferred.resolve()

    } catch(error) {
      deferred.reject(error)

    }
  })
  return deferred.promise
}

/**
 */
Blockchain.prototype.mainIteration = function() {
  var self = this

  Q.spawn(function* () {
    try {
      yield self.catchUp()
      yield self.updateMempool()

    } catch (error) {
      console.error(error)

    }

    setTimeout(self.mainIteration.bind(self), 5*1000)
  })
}

/**
 * @param {string} txId
 * @param {number} outIndex
 * @return {Q.Promise}
 */
Blockchain.prototype.getAddress = function(txId, outIndex) {
  if (!_.isUndefined(this.mempool.addrs[txId + outIndex]))
    return Q(this.mempool.addrs[txId + outIndex])

  return this.storage.getAddress(txId, outIndex)
}

/**
 * @param {string} address
 * @return {Q.Promise}
 */
Blockchain.prototype.getCoins = function(address) {
  var self = this

  return self.storage.getCoins(address).then(function(coins) {
    // add unconfirmed coins
    var mempoolCoins = self.mempool.coins[address] || {}
    Object.keys(mempoolCoins).forEach(function(cTxId) {
      Object.keys(mempoolCoins[cTxId]).forEach(function(cIndex) {
        coins.push({
          cTxId: cTxId,
          cIndex: cIndex,
          cValue: mempoolCoins[cTxId][cIndex],
          cHeight: 0,
          sTxId: null,
          sHeight: 0
        })
      })
    })

    // fill unconfirmed spent coins
    coins.forEach(function(coin) {
      var sTxId = (self.mempool.spent[coin.cTxId] || {})[coin.cIndex]
      if (_.isUndefined(sTxId))
        return

      coin.sTxId = sTxId
      coin.sHeight = 0
    })

    return coins
  })
}

/**
 * @param {string} txHash
 * @return {Q.Promise}
 */
Blockchain.prototype.getRawTx = function(txHash) {
  return this.bitcoind('getrawtransaction', txHash, 0).spread(function(rawTx) { return rawTx })
}

/**
 * @param {string} rawTx
 * @return {Q.Promise}
 */
Blockchain.prototype.sendRawTx = function(rawTx) {
  return this.bitcoind('sendrawtransaction', rawTx).spread(function(txId) { return txId })
}

/**
 * @param {string} txHash
 * @param {number} height
 * @return {Q.Promise}
 */
Blockchain.prototype.getMerkle = function(txHash, height) {
  // Todo: move to subprocess
  var self = this

  var deferred = Q.defer()
  Q.spawn(function* () {
    try {
      var blockHash = (yield self.bitcoind('getblockhash', height))[0]
      var block = (yield self.bitcoind('getblock', blockHash))[0]

      var merkle = block.tx.map(util.hashDecode)
      var targetHash = util.hashDecode(txHash)
      var result = []
      while (merkle.length !== 1) {
        if (merkle.length % 2 === 1)
          merkle.push(merkle[merkle.length-1])

        var newMerkle = []
        for (var i = 0; i < merkle.length; i += 2) {
          var newHash = util.hash256(merkle[i] + merkle[i+1])
          newMerkle.push(newHash)

          if (bufferEqual(merkle[i], targetHash)) {
            result.push(util.hashEncode(merkle[i+1]))
            targetHash = newHash
          } else if (bufferEqual(merkle[i+1], targetHash)) {
            result.push(util.hashEncode(merkle[i]))
            targetHash = newHash
          }
        }
        merkle = newMerkle
      }

      deferred.resolve({ tree: result, pos: block.tx.indexOf(txHash) })

    } catch (error) {
      deferred.reject(error)

    }
  })
  return deferred.promise
}

/**
 * @param {number} nblocks
 * @return {Q.Promise}
 */
Blockchain.prototype.estimatefee = function(nblocks) {
  return this.bitcoind('estimatefee', nblocks).spread(function(fee) { return fee })
}


module.exports = Blockchain
