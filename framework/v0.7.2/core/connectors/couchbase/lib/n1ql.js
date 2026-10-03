"use strict";
/**
 * @class N1QLEntity
 *
 * This class is shared between N1QL queries without entity
 *
 * @package     N1QLEntity
 * @namespace
 * @author
 */
function N1QLEntity() {
    var n1ql       = this.getConnection();
}

module.exports = N1QLEntity;