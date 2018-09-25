var should    = require('chai').should();
var supertest = require('supertest');
var api       = supertest('http://localhost:3000/api');

describe('Stream unit tests:', () => {
    it('Should create a Stream instance', (done: Function) => {
        api.post('/streams').send({}).expect(200, done);
    });
});
