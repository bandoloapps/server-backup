import { STRING, Sequelize } from "sequelize";

export const define_users = (sequelize: Sequelize) => {
    const model = sequelize.define('users', {
            userId: {
                type: STRING,
                primaryKey: true
            },
            username: {
                type: STRING
            },
            displayName: {
                type: STRING
            },
            globalName: {
                type: STRING,
                allowNull: true
            }
        }, {timestamps: false, freezeTableName: true})

    return model;
}
